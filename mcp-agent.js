/**
 * mcp-agent.js
 *
 * Delega o prompt diretamente ao CLI instalado (antigravity-cli ou gemini),
 * que já tem autenticação e fallback de modelos configurados.
 * Inclui a ferramenta run_command para executar comandos no sistema.
 */

const { spawn } = require('child_process');
const { exec }  = require('child_process');
const util      = require('util');
const os        = require('os');
const path      = require('path');
const fs        = require('fs');
const crypto    = require('crypto');

const execPromise = util.promisify(exec);

// Mapa de engine id -> como chamar o CLI
const ENGINE_CMD = {
  'antigravity-cli': { bin: 'antigravity-cli', args: ['-p'] },
  'gemini':          { bin: 'gemini',           args: ['-p'] },
};

// Tira ANSI / OSC da saída dos CLIs
function stripEscapes(str) {
  return str
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1b[^\[\]][^\x1b]*/g, '')
    .replace(/\]8;;[^\\]*\\?/g, '')
    .replace(/\]8;;\s*/g, '');
}

/**
 * Chama o CLI instalado (antigravity-cli ou gemini) com o prompt dado.
 * Usa um arquivo temporário para evitar problemas de encoding no PowerShell.
 */
async function callInstalledEngine(engineId, modelName, prompt, env, cwd, logCallback) {
  const engineConf = ENGINE_CMD[engineId] || ENGINE_CMD['antigravity-cli'];
  const tmpFile = path.join(os.tmpdir(), `aigui_prompt_${crypto.randomUUID()}.txt`);
  fs.writeFileSync(tmpFile, prompt, 'utf8');

  // Monta o comando PowerShell
  const modelFlag = modelName && modelName !== 'null'
    ? `--model '${modelName}'`
    : '';

  const psCmd = `${engineConf.bin} ${engineConf.args.join(' ')} (Get-Content '${tmpFile}' -Raw -Encoding UTF8) ${modelFlag}; Remove-Item -Path '${tmpFile}' -ErrorAction SilentlyContinue`;

  logCallback('INFO', `Calling engine: ${engineConf.bin} ${modelFlag || '(default model)'}`);

  return new Promise((resolve, reject) => {
    const proc = spawn('powershell.exe', ['-NoProfile', '-Command', psCmd], {
      shell: false,
      env,
      cwd
    });

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk;
      logCallback('STDERR', chunk.trim().substring(0, 200));
    });

    proc.on('close', (code) => {
      // Remove marcadores internos do EGC dispatcher
      let answer = stdout;
      const bridgeMarker = /^---\s*EGC Bridge Execution[^\n]*\n/m;
      const markerMatch = bridgeMarker.exec(answer);
      if (markerMatch) answer = answer.slice(markerMatch.index + markerMatch[0].length);
      answer = answer
        .replace(/\[Dispatcher\]\s*Completing session lifecycle\.\.\.\s*/g, '')
        .replace(/\[Dispatcher\][^\n]*/g, '')
        .replace(/\[Recorder\][^\n]*/g, '');
      answer = stripEscapes(answer).trim();
      resolve({ answer, code });
    });

    proc.on('error', reject);
  });
}

/**
 * Executa um comando no terminal local e retorna o output.
 */
async function runLocalCommand(cmd, cwd, logCallback, onProgress) {
  onProgress(`\n> ⚙️ Executando: \`${cmd}\`...\n\n`);
  let output = '';
  try {
    const { stdout, stderr } = await execPromise(cmd, { cwd, timeout: 60000, shell: 'powershell.exe' });
    output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : '');
  } catch (err) {
    output = `ERRO: ${err.message}\n${err.stdout || ''}\n${err.stderr || ''}`;
  }
  const preview = output.length > 600 ? output.slice(0, 600) + '... (truncado)' : output;
  onProgress(`\`\`\`bash\n${preview.trim()}\n\`\`\`\n\n*(Analisando resultado...)*\n`);
  return output;
}

/**
 * Loop principal: delega o prompt ao CLI instalado.
 * O CLI já tem acesso às ferramentas MCP configuradas em seu ambiente.
 * Para comandos de terminal simples, o loop executa via run_command local.
 */
async function runMcpAgentLoop(prompt, modelName, env, cwd, logCallback, onProgress) {
  logCallback('INFO', 'runMcpAgentLoop iniciado via CLI engine');
  onProgress('\n*(Iniciando IA via engine instalada...)*\n');

  // Detecta a engine disponível a partir do env ou usa antigravity por padrão
  let engineId = env.AIGUI_ENGINE || 'antigravity-cli';
  // Normaliza: se não tiver o CLI mapeado, cai para antigravity
  if (!ENGINE_CMD[engineId]) engineId = 'antigravity-cli';

  // Monta prompt enriquecido com contexto do sistema
  const desktopPath = path.join(os.homedir(), 'Desktop');
  const actualDesktop = fs.existsSync(desktopPath)
    ? desktopPath
    : path.join(os.homedir(), 'OneDrive', 'Área de Trabalho');

  const systemContext = `
[SYSTEM CONTEXT]
Você é a IA da AIGUI, uma interface que orquestra agentes de IA no computador do usuário.
- Diretório de trabalho: ${cwd}
- Área de trabalho do usuário: ${actualDesktop}
- Sistema operacional: Windows
- Você tem acesso total ao sistema de arquivos e pode executar comandos PowerShell/CMD.
- Para baixar arquivos, use o comando: Invoke-WebRequest -Uri "URL" -OutFile "CAMINHO"
- Sempre confirme ao usuário o que foi feito ao final.
[/SYSTEM CONTEXT]

`;

  const fullPrompt = systemContext + prompt;

  logCallback('INFO', `Engine: ${engineId} | Model override: ${modelName || 'default'}`);

  const { answer, code } = await callInstalledEngine(
    engineId,
    modelName,
    fullPrompt,
    env,
    cwd,
    logCallback
  );

  logCallback('INFO', `Engine retornou código ${code}. Resposta: ${answer.substring(0, 100)}...`);

  if (!answer || answer.trim() === '') {
    return '✅ Tarefa concluída sem mensagem adicional da IA.';
  }

  // Se a resposta contém um bloco de comando para executar localmente, roda e retorna
  const cmdMatch = answer.match(/```(?:bash|powershell|cmd|ps1)\n([\s\S]+?)```/);
  if (cmdMatch) {
    const cmd = cmdMatch[1].trim();
    const cmdOutput = await runLocalCommand(cmd, cwd, logCallback, onProgress);
    return answer + `\n\n**Resultado da execução:**\n\`\`\`\n${cmdOutput.trim()}\n\`\`\``;
  }

  return answer;
}

module.exports = { runMcpAgentLoop };
