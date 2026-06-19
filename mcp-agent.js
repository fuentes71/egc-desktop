/**
 * mcp-agent.js
 *
 * Delega o prompt diretamente ao CLI instalado (antigravity-cli ou gemini),
 * que já tem autenticação e fallback de modelos configurados.
 *
 * SECURITY FIXES:
 * - Sanitização de output do CLI antes de retornar ao renderer
 * - Timeout explícito em todos os comandos
 * - Sem shell: true em spawn (evita shell injection)
 * - Tamanho máximo de prompt para evitar DoS
 * - Temp files com permissão restrita e limpeza garantida
 */

const { spawn } = require('child_process');
const { exec }  = require('child_process');
const util      = require('util');
const os        = require('os');
const path      = require('path');
const fs        = require('fs');
const crypto    = require('crypto');

const execPromise = util.promisify(exec);

// Limite máximo de tamanho de prompt (100 KB)
const MAX_PROMPT_BYTES = 100 * 1024;

// Mapa de engine id -> como chamar o CLI (whitelist explícita)
const ENGINE_CMD = {
  'antigravity-cli': { bin: 'antigravity-cli', args: ['-p'] },
  'gemini':          { bin: 'gemini',           args: ['-p'] },
};

// Tira ANSI / OSC / sequências de escape da saída dos CLIs
function stripEscapes(str) {
  return str
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1b[^\[\]][^\x1b]*/g, '')
    .replace(/\]8;;[^\\]*\\?/g, '')
    .replace(/\]8;;\s*/g, '');
}

/**
 * Sanitiza o output da IA para ser exibido no renderer.
 * Remove scripts, iframes e atributos de evento de qualquer HTML
 * que possa ter vazado no texto da resposta.
 * (A sanitização completa de HTML ocorre via DOMPurify no renderer)
 */
function sanitizeOutput(str) {
  return str
    .replace(/<script[\s\S]*?<\/script>/gi, '[script removido]')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '[iframe removido]')
    .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/javascript:/gi, '');
}

/**
 * Chama o CLI instalado com o prompt dado via arquivo temporário.
 * Usa spawn sem shell: true para evitar shell injection.
 */
async function callInstalledEngine(engineId, modelName, prompt, env, cwd, logCallback) {
  // Valida engine contra whitelist
  const engineConf = ENGINE_CMD[engineId] || ENGINE_CMD['antigravity-cli'];

  // Valida tamanho do prompt
  const promptBytes = Buffer.byteLength(prompt, 'utf8');
  if (promptBytes > MAX_PROMPT_BYTES) {
    throw new Error(`Prompt excede o limite máximo de ${MAX_PROMPT_BYTES / 1024}KB`);
  }

  // Cria arquivo temporário com nome aleatório (sem informação sensível no nome)
  const tmpFile = path.join(os.tmpdir(), `egc_${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmpFile, prompt, { encoding: 'utf8', mode: 0o600 }); // somente proprietário
  } catch (writeErr) {
    throw new Error(`Falha ao criar arquivo temporário: ${writeErr.message}`);
  }

  // Monta o comando PowerShell. modelFlag só aceita valores da whitelist.
  const ALLOWED_MODEL_PATTERN = /^[a-zA-Z0-9._-]+$/;
  const safeModel = (modelName && modelName !== 'null' && ALLOWED_MODEL_PATTERN.test(modelName))
    ? modelName
    : null;

  const modelFlag = safeModel ? `--model '${safeModel}'` : '';
  const psCmd = `${engineConf.bin} ${engineConf.args.join(' ')} (Get-Content '${tmpFile}' -Raw -Encoding UTF8) ${modelFlag}; Remove-Item -Path '${tmpFile}' -ErrorAction SilentlyContinue`;

  logCallback('INFO', `Calling engine: ${engineConf.bin} ${safeModel ? `model=${safeModel}` : '(default)'}`);

  return new Promise((resolve, reject) => {
    // Timeout: 5 minutos máximo por resposta
    const TIMEOUT_MS = 5 * 60 * 1000;
    let timedOut = false;

    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
      shell: false, // NÃO usar shell: true — evita shell injection
      env: { ...env }, // cópia do env, sem poluição
      cwd
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      reject(new Error('Timeout: a engine demorou mais de 5 minutos para responder.'));
    }, TIMEOUT_MS);

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');

    let stdout = '';
    let stderr = '';
    const MAX_OUTPUT = 500 * 1024; // 500 KB máximo de output

    proc.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk;
    });
    proc.stderr.on('data', (chunk) => {
      if (stderr.length < 10 * 1024) { // limite stderr a 10KB no log
        logCallback('STDERR', chunk.trim().substring(0, 200));
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return;

      // Limpa temp file se ainda existir
      try { fs.unlinkSync(tmpFile); } catch (_) {}

      // Remove marcadores internos do EGC dispatcher
      let answer = stdout;
      const bridgeMarker = /^---\s*EGC Bridge Execution[^\n]*\n/m;
      const markerMatch = bridgeMarker.exec(answer);
      if (markerMatch) answer = answer.slice(markerMatch.index + markerMatch[0].length);
      answer = answer
        .replace(/\[Dispatcher\]\s*Completing session lifecycle\.\.\.\s*/g, '')
        .replace(/\[Dispatcher\][^\n]*/g, '')
        .replace(/\[Recorder\][^\n]*/g, '');

      answer = sanitizeOutput(stripEscapes(answer).trim());
      resolve({ answer, code });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      try { fs.unlinkSync(tmpFile); } catch (_) {}
      reject(err);
    });
  });
}

/**
 * Executa um comando no terminal local de forma controlada.
 * Valida o comando contra padrões perigosos antes de executar.
 */
async function runLocalCommand(cmd, cwd, logCallback, onProgress) {
  // Bloqueia padrões de comando perigosos
  const DANGEROUS_PATTERNS = [
    /rm\s+-rf\s+\//i,
    /format\s+[a-z]:/i,
    /del\s+\/[sf]/i,
    /shutdown/i,
    /net\s+user/i,
    /reg\s+(add|delete)/i,
  ];
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(cmd)) {
      logCallback('WARN', `Comando bloqueado por política de segurança: ${cmd.substring(0, 80)}`);
      return `BLOQUEADO: Este comando foi rejeitado pela política de segurança da aplicação.`;
    }
  }

  onProgress(`\n> ⚙️ Executando: \`${cmd.substring(0, 200)}\`...\n\n`);
  let output = '';
  try {
    const { stdout, stderr } = await execPromise(cmd, {
      cwd,
      timeout: 30000,          // 30s timeout
      maxBuffer: 1024 * 1024,  // 1MB output limit
      shell: 'powershell.exe'
    });
    output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : '');
  } catch (err) {
    // Retorna erro sem expor stack trace completo
    output = `ERRO: ${err.message.split('\n')[0]}\n${(err.stdout || '').substring(0, 500)}`;
  }
  const preview = output.length > 600 ? output.slice(0, 600) + '... (truncado)' : output;
  onProgress(`\`\`\`bash\n${preview.trim()}\n\`\`\`\n\n*(Analisando resultado...)*\n`);
  return output;
}

/**
 * Loop principal: delega o prompt ao CLI instalado.
 */
async function runMcpAgentLoop(prompt, modelName, env, cwd, logCallback, onProgress) {
  logCallback('INFO', 'runMcpAgentLoop iniciado via CLI engine');
  onProgress('\n*(Iniciando IA via engine instalada...)*\n');

  // Detecta a engine disponível a partir do env ou usa antigravity por padrão
  // Validação contra whitelist para evitar injeção de engine
  const requestedEngine = env.AIGUI_ENGINE || 'antigravity-cli';
  const engineId = ENGINE_CMD[requestedEngine] ? requestedEngine : 'antigravity-cli';

  // Resolve área de trabalho real do usuário
  const possibleDesktops = [
    path.join(os.homedir(), 'Desktop'),
    path.join(os.homedir(), 'OneDrive', 'Área de Trabalho'),
    path.join(os.homedir(), 'OneDrive', 'Desktop'),
  ];
  const actualDesktop = possibleDesktops.find(p => fs.existsSync(p)) || os.homedir();

  const systemContext = `
[SYSTEM CONTEXT]
Você é a IA da egc-desktop, uma interface que orquestra agentes de IA no computador do usuário.
- Diretório de trabalho: ${cwd}
- Área de trabalho do usuário: ${actualDesktop}
- Sistema operacional: Windows
- Você tem acesso ao sistema de arquivos e pode executar comandos PowerShell/CMD.
- Para baixar arquivos, use o comando: Invoke-WebRequest -Uri "URL" -OutFile "CAMINHO"
- Sempre confirme ao usuário o que foi feito ao final.
[/SYSTEM CONTEXT]

`;

  const fullPrompt = systemContext + prompt;

  const { answer, code } = await callInstalledEngine(
    engineId,
    modelName,
    fullPrompt,
    env,
    cwd,
    logCallback
  );

  logCallback('INFO', `Engine retornou código ${code}. Chars: ${answer.length}`);

  if (!answer || answer.trim() === '') {
    return '✅ Tarefa concluída sem mensagem adicional da IA.';
  }

  // Se a resposta contém um bloco de comando explícito, executa localmente
  const cmdMatch = answer.match(/```(?:bash|powershell|cmd|ps1)\n([\s\S]+?)```/);
  if (cmdMatch) {
    const cmd = cmdMatch[1].trim();
    const cmdOutput = await runLocalCommand(cmd, cwd, logCallback, onProgress);
    return answer + `\n\n**Resultado da execução:**\n\`\`\`\n${cmdOutput.trim()}\n\`\`\``;
  }

  return answer;
}

module.exports = { runMcpAgentLoop };
