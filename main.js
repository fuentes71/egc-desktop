const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── Logger ────────────────────────────────────────────────────────
const LOG_FILE = path.join(__dirname, 'aigui.log');

function log(level, ...args) {
  const ts = new Date().toISOString();
  const msg = `[${ts}] [${level}] ${args.join(' ')}`;
  console.log(msg);
  fs.appendFileSync(LOG_FILE, msg + '\n', 'utf-8');
}

// Clear log on startup
fs.writeFileSync(LOG_FILE, `=== AIGUI started at ${new Date().toISOString()} ===\n`, 'utf-8');
log('INFO', 'main.js loaded');

const Database = require('better-sqlite3');
const dbPath = path.join(app.getPath('userData'), 'conversations.sqlite');
const db = new Database(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    summary TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER,
    sender TEXT,
    content TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(conversation_id) REFERENCES conversations(id)
  );
`);

// Add title column if it doesn't exist (migration)
try {
  db.exec('ALTER TABLE conversations ADD COLUMN title TEXT');
} catch (e) {
  // column might already exist
}

log('INFO', 'SQLite initialized at', dbPath);

let currentConversationId = null;

function ensureConversation() {
  if (!currentConversationId) {
    const stmt = db.prepare('INSERT INTO conversations (title, summary) VALUES (NULL, NULL)');
    const info = stmt.run();
    currentConversationId = info.lastInsertRowid;
    log('INFO', 'Started new conversation:', currentConversationId);
  }
}

ipcMain.on('get-conversations', (event) => {
  try {
    const rows = db.prepare('SELECT id, title, summary, created_at FROM conversations ORDER BY created_at DESC').all();
    event.sender.send('conversations-list', rows);
  } catch (err) {
    log('ERROR', 'Failed to get conversations:', err.message);
  }
});

ipcMain.on('load-conversation', (event, convId) => {
  try {
    const messages = db.prepare('SELECT sender, content FROM messages WHERE conversation_id = ? ORDER BY id ASC').all(convId);
    currentConversationId = convId;
    event.sender.send('conversation-loaded', messages);
  } catch (err) {
    log('ERROR', 'Failed to load conversation:', err.message);
  }
});

/**
 * Strip ANSI color codes + OSC escape sequences (hyperlinks, etc.)
 * produced by the EGC terminal output.
 */
function stripEscapes(str) {
  return str
    // OSC sequences: ESC ] ... ST  or  ESC ] ... BEL
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // CSI sequences: ESC [ ... final byte
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    // Bare ESC sequences
    .replace(/\x1b[^\[\]][^\x1b]*/g, '')
    // OSC-8 hyperlinks that arrive without proper ESC prefix (]8;;url\text]8;;\)
    .replace(/\]8;;[^\\]*\\?/g, '')
    .replace(/\]8;;\s*/g, '');
}

let mainWindow;

function createWindow() {
  log('INFO', 'Creating BrowserWindow...');
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,   // isola contexto renderer do main
      nodeIntegration: false,   // renderer sem acesso Node
      sandbox: true,            // sandbox do Chromium ativo
      webSecurity: true,        // same-origin policy ativa
      allowRunningInsecureContent: false
    },
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#1e1e2e',
      symbolColor: '#cdd6f4'
    }
  });

  mainWindow.loadFile('index.html');

  // Bloqueia qualquer tentativa de navegação para URL externa
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      log('WARN', `Navegação bloqueada para: ${url}`);
    }
  });

  // Bloqueia abertura de novas janelas (ex: window.open)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      require('electron').shell.openExternal(url);
    } else {
      log('WARN', `Abertura de janela bloqueada: ${url}`);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-finish-load', () => {
    log('INFO', 'Renderer finished loading');
  });

  mainWindow.webContents.on('console-message', (_e, level, msg, line, src) => {
    // Não loga mensagens do renderer que contenham dados sensíveis
    const safeMsg = msg.substring(0, 300);
    log('RENDERER', `[${src}:${line}] ${safeMsg}`);
  });
}

app.whenReady().then(() => {
  log('INFO', 'App ready');
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', (e) => {
  log('INFO', 'App quitting, compacting conversation...');
  compactConversation(currentConversationId);
});

app.on('window-all-closed', () => {
  log('INFO', 'All windows closed');
  if (process.platform !== 'darwin') app.quit();
});

// ── Save Conversation ────────────────────────────────────────────
ipcMain.on('save-conversation', (event, text) => {
  const oldConvId = currentConversationId;
  currentConversationId = null; // start fresh
  compactConversation(oldConvId);

  try {
    const chatsDir = path.join(app.getPath('userData'), 'conversas-salvas');
    if (!fs.existsSync(chatsDir)) {
      fs.mkdirSync(chatsDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filepath = path.join(chatsDir, `conversa_${timestamp}.md`);
    fs.writeFileSync(filepath, text, 'utf-8');
    log('INFO', `Conversa salva em: ${filepath}`);
  } catch (err) {
    log('ERROR', 'Falha ao salvar conversa:', err.message);
  }
});

// ── Delete Conversation ──────────────────────────────────────────
ipcMain.on('delete-conversation', (event, convId) => {
  const idToDelete = convId || currentConversationId;
  if (idToDelete) {
    try {
      db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(idToDelete);
      db.prepare('DELETE FROM conversations WHERE id = ?').run(idToDelete);
      log('INFO', `Conversa ${idToDelete} excluída com sucesso do banco de dados.`);
      if (currentConversationId === idToDelete) {
        currentConversationId = null;
      }
      
      const rows = db.prepare('SELECT id, title, summary, created_at FROM conversations ORDER BY created_at DESC').all();
      event.sender.send('conversations-list', rows);

    } catch (err) {
      log('ERROR', `Falha ao excluir conversa ${idToDelete}:`, err.message);
    }
  }
});

// ── Open External URL ────────────────────────────────────────────
ipcMain.on('open-external', (_event, url) => {
  log('INFO', 'open-external:', url);
  shell.openExternal(url);
});

// ── .env helpers (Direct connection to EGC Environment) ────────────
function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  const env = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim().replace(/^"|"$/g, '');
    if (key && val) env[key] = val;
  }
  return env;
}

function buildEgcEnv() {
  const HOME = os.homedir();
  const egcGlobal = path.join(HOME, 'AppData', 'Roaming', 'npm', 'node_modules', '@egchq', 'egc', '.env');
  const egcLocal  = path.join(HOME, 'Projects', 'EGC', '.env');

  const globalEnv = loadDotEnv(egcGlobal);
  const localEnv  = loadDotEnv(egcLocal);

  return { ...process.env, ...globalEnv, ...localEnv, PYTHONIOENCODING: 'utf-8', PYTHONLEGACYWINDOWSSTDIO: '0' };
}

// ── Get Installed Engines ────────────────────────────────────────────
ipcMain.on('get-installed-engines', async (event) => {
  log('INFO', 'IPC get-installed-engines received');
  const HOME = os.homedir();
  const availableEngines = [];

  const targets = [
    { name: 'Antigravity CLI', cmd: 'antigravity-cli', gate: () => fs.existsSync(path.join(HOME, '.gemini', 'antigravity-cli')) },
    { name: 'Gemini CLI',      cmd: 'gemini',          gate: () => fs.existsSync(path.join(HOME, '.gemini', 'config')) },
    { name: 'Claude Code',     cmd: 'claude',          gate: () => fs.existsSync(path.join(HOME, '.claude')) },
    { name: 'Cursor',          cmd: 'cursor',          gate: () => fs.existsSync(path.join(HOME, '.cursor')) },
    { name: 'Kiro',            cmd: 'kiro',            gate: () => fs.existsSync(path.join(HOME, '.kiro')) },
    { name: 'Codex CLI',       cmd: 'codex',           gate: () => fs.existsSync(path.join(HOME, '.codex', 'config.toml')) },
    { name: 'OpenCode',        cmd: 'opencode',        gate: () => fs.existsSync(path.join(HOME, '.config', 'opencode', 'config.json')) },
  ];

  for (const target of targets) {
    const found = target.gate();
    log('INFO', `  ${target.name}: ${found ? 'FOUND' : 'not found'}`);
    if (found) availableEngines.push({ id: target.cmd, name: target.name });
  }

  if (availableEngines.length === 0) {
    log('WARN', 'No engines detected, using CMD fallback');
    availableEngines.push({ id: 'cmd', name: 'Terminal Padrão (CMD)' });
  }

  log('INFO', 'Engines found:', availableEngines.map(e => e.name).join(', '));
  event.sender.send('installed-engines-list', availableEngines);
});

const { exec, spawn } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

// ── Working directory and EGC Permissions ────────────────────────
let workingDir = os.homedir(); // default: home dir
let egcPermissionLevel = 'unknown';

function checkEgcPermissions() {
  log('INFO', 'Buscando nível de permissão diretamente no EGC...');
  // Tenta buscar no banco de estados ou via cli qual o acesso
  exec('egc status', { cwd: workingDir }, (err, stdout) => {
    if (err) {
      log('WARN', 'Não foi possível ler permissões do EGC. Usando padrão (restrito).');
      egcPermissionLevel = 'restricted';
      return;
    }
    // Analisa a saída ou estado do EGC para determinar permissão real
    // Exemplo: se houver sessões ativas ou EGC instalado globalmente, assumir acesso amplo
    if (stdout.includes('EGC status')) {
      egcPermissionLevel = 'full-access';
      log('INFO', 'EGC confirmou permissão total ao sistema do usuário.');
    } else {
      egcPermissionLevel = 'restricted';
      log('INFO', 'EGC não confirmou permissões ampliadas. Acesso restrito.');
    }
  });
}

checkEgcPermissions();



const crypto = require('crypto');

async function callEgcPrompt(text, model, env) {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(os.tmpdir(), `egc_prompt_${crypto.randomUUID()}.txt`);
    fs.writeFileSync(tmpFile, text, 'utf8');

    const cmdStr = model
      ? `egc prompt -p (Get-Content '${tmpFile}' -Raw -Encoding UTF8) --model '${model}'; Remove-Item -Path '${tmpFile}' -ErrorAction SilentlyContinue`
      : `egc prompt -p (Get-Content '${tmpFile}' -Raw -Encoding UTF8); Remove-Item -Path '${tmpFile}' -ErrorAction SilentlyContinue`;

    log('INFO', 'Executing via PS using tmp file:', tmpFile);

    const aiProcess = spawn('powershell.exe', ['-NoProfile', '-Command', cmdStr], {
      shell: false,
      env,
      cwd: workingDir
    });

    aiProcess.stdout.setEncoding('utf8');
    aiProcess.stderr.setEncoding('utf8');

    let stdoutBuffer = '';
    aiProcess.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
    });

    aiProcess.stderr.on('data', (chunk) => {
      const raw = chunk.toString();
      log('STDERR', raw.trim());
    });

    aiProcess.on('close', (code) => {
      let answer = stdoutBuffer;
      const bridgeMarker = /^---\s*EGC Bridge Execution[^\n]*\n/m;
      const markerMatch = bridgeMarker.exec(answer);
      if (markerMatch) {
        answer = answer.slice(markerMatch.index + markerMatch[0].length);
      }
      answer = answer
        .replace(/\[Dispatcher\]\s*Completing session lifecycle\.\.\.\s*/g, '')
        .replace(/\[Dispatcher\][^\n]*/g, '')
        .replace(/\[Recorder\][^\n]*/g, '');

      answer = stripEscapes(answer).trim();
      resolve({ answer, code });
    });

    aiProcess.on('error', (err) => {
      reject(err);
    });
  });
}

async function compactConversation(convId) {
  if (!convId) return;
  
  const messages = db.prepare('SELECT sender, content FROM messages WHERE conversation_id = ? ORDER BY id ASC').all(convId);
  if (messages.length === 0) return;

  const conv = db.prepare('SELECT summary FROM conversations WHERE id = ?').get(convId);
  if (conv && conv.summary) return; // already compacted

  let textToCompact = messages.map(m => `**${m.sender}:**\n${m.content}`).join('\n\n---\n\n');
  const prompt = `Por favor, crie um resumo curto (compactado) sobre esta conversa. O resumo deve capturar os pontos principais:\n\n${textToCompact}`;

  log('INFO', `Compacting conversation ${convId}...`);
  try {
    const env = buildEgcEnv();
    const { answer, code } = await callEgcPrompt(prompt, null, env);
    if (code === 0 && answer) {
      db.prepare('UPDATE conversations SET summary = ? WHERE id = ?').run(answer, convId);
      log('INFO', `Conversation ${convId} compacted successfully.`);
    }
  } catch(err) {
    log('ERROR', 'Failed to compact conversation:', err.message);
  }
}

// Compacta a cada 2 horas
setInterval(() => {
  log('INFO', '2 hours passed, triggering conversation compaction...');
  compactConversation(currentConversationId);
}, 2 * 60 * 60 * 1000);

ipcMain.on('send-prompt', async (event, data) => {
  // Valida e sanitiza o input do renderer antes de qualquer uso
  if (!data || typeof data !== 'object') {
    log('WARN', 'IPC send-prompt: payload inválido ignorado');
    return;
  }

  const text   = (typeof data.text   === 'string' ? data.text   : '').trim().slice(0, 100000);
  const engine = (typeof data.engine === 'string' ? data.engine : '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  const model  = (typeof data.model  === 'string' ? data.model  : '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 64);

  if (!text) {
    log('WARN', 'IPC send-prompt: texto vazio ignorado');
    return;
  }

  log('INFO', `IPC send-prompt received: text="${text.substring(0,80)}" engine="${engine}" model="${model}"`);
  log('INFO', 'Working dir:', workingDir);

  let isNewConversation = false;
  if (!currentConversationId) {
    ensureConversation();
    isNewConversation = true;
  }

  db.prepare('INSERT INTO messages (conversation_id, sender, content) VALUES (?, ?, ?)')
    .run(currentConversationId, 'Usuário', text);

  // Generate title async if it's new
  if (isNewConversation) {
    const convIdToTitle = currentConversationId;
    const titlePrompt = `Crie um título com no máximo 4 palavras resumindo esta mensagem (nao inclua aspas): ${text}`;
    callEgcPrompt(titlePrompt, null, buildEgcEnv()).then(({ answer, code }) => {
      if (code === 0 && answer) {
        db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(answer, convIdToTitle);
        log('INFO', `Title generated for conversation ${convIdToTitle}: ${answer}`);
        // Refresh sidebar
        const rows = db.prepare('SELECT id, title, summary, created_at FROM conversations ORDER BY created_at DESC').all();
        event.sender.send('conversations-list', rows);
      }
    }).catch(e => log('ERROR', 'Failed to generate title:', e.message));
  }

  const env = buildEgcEnv();
  env.AIGUI_ENGINE = engine; // passa o engine escolhido no frontend
  const { runMcpAgentLoop } = require('./mcp-agent.js');

  let currentPrompt = `${text}\n\n[SYSTEM NOTE: Você é a IA principal operando através da interface AIGUI, mas o seu "cérebro" e ambiente de execução é o EGC (Extended Global Context). Você tem acesso total e direto ao computador do usuário, ao sistema de arquivos, a outros projetos e a diversas aplicações através das ferramentas MCP fornecidas pelo EGC. Você não está restrita a projetos específicos; utilize as ferramentas MCP livremente para analisar, criar, modificar, executar comandos no terminal local e controlar aplicações conforme solicitado pelo usuário. Seja prestativa e retorne respostas bem formatadas em Markdown.]`;

  try {
    const finalAnswer = await runMcpAgentLoop(
      currentPrompt, 
      model, 
      env, 
      workingDir, 
      log, 
      () => {} // Ignora status progressivo para manter a animação "..."
    );

    db.prepare('INSERT INTO messages (conversation_id, sender, content) VALUES (?, ?, ?)')
      .run(currentConversationId, 'IA', finalAnswer);
      
    event.sender.send('receive-response', finalAnswer);
    event.sender.send('process-finished', 0);
    
  } catch (err) {
    log('ERROR', 'Falha ao processar comando:', err.message);
    event.sender.send('receive-response', `\n[ERRO FATAL]: ${err.message}`);
    event.sender.send('process-finished', 1);
  }
});

