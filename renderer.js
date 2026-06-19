const promptInput = document.getElementById('prompt-input');
const sendBtn = document.getElementById('send-btn');
const chatHistory = document.getElementById('chat-history');
const engineSelect = document.getElementById('engine-select');
const slashPopup = document.getElementById('slash-popup');
const modelBadge = document.getElementById('model-badge');
const newChatBtn = document.querySelector('.new-chat-btn');

newChatBtn.addEventListener('click', () => {
  const messages = chatHistory.querySelectorAll('.message');
  if (messages.length <= 1) return; // Só tem a mensagem do sistema

  let chatText = '';
  messages.forEach(msg => {
    const isUser = msg.classList.contains('user');
    const sender = isUser ? 'Usuário' : (msg.classList.contains('system') ? 'Sistema' : 'IA');
    const content = msg.querySelector('.content').innerText;
    chatText += `**${sender}:**\n${content}\n\n---\n\n`;
  });

  window.electronAPI.saveConversation(chatText);

  chatHistory.innerHTML = `
    <div class="message system">
      <div class="avatar">⚙️</div>
      <div class="content">
        Sistema pronto. Digite um comando para que a IA processe no terminal.
      </div>
    </div>
  `;
});

const conversationList = document.getElementById('conversation-list');

function renderConversations(list) {
  conversationList.innerHTML = '';
  list.forEach(conv => {
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="title" title="${conv.summary || ''}">${conv.title || 'Nova Conversa'}</div>
      <button class="chat-options-btn" aria-label="Opções">
        <svg stroke="currentColor" fill="none" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round" height="16" width="16" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="1"></circle><circle cx="12" cy="5" r="1"></circle><circle cx="12" cy="19" r="1"></circle></svg>
      </button>
      <div class="chat-dropdown">
        <button class="delete-btn">Excluir conversa</button>
      </div>
    `;
    
    const optionsBtn = li.querySelector('.chat-options-btn');
    const dropdown = li.querySelector('.chat-dropdown');
    const deleteBtn = li.querySelector('.delete-btn');

    optionsBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // prevent loading conversation
      document.querySelectorAll('.chat-dropdown').forEach(d => {
        if (d !== dropdown) d.classList.remove('open');
      });
      dropdown.classList.toggle('open');
    });

    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm('Tem certeza que deseja excluir esta conversa do banco de dados?')) {
        window.electronAPI.deleteConversation(conv.id);
        chatHistory.innerHTML = `
          <div class="message system">
            <div class="avatar">⚙️</div>
            <div class="content">
              Conversa excluída. Digite um comando para que a IA processe no terminal.
            </div>
          </div>
        `;
      }
    });

    li.addEventListener('click', () => {
      window.electronAPI.loadConversation(conv.id);
    });

    conversationList.appendChild(li);
  });
}

window.electronAPI.onConversationsList((list) => {
  renderConversations(list);
});

// Close dropdowns on document click
document.addEventListener('click', () => {
  document.querySelectorAll('.chat-dropdown').forEach(d => d.classList.remove('open'));
});

// Load conversations on startup
window.electronAPI.getConversations();

window.electronAPI.onConversationLoaded((messages) => {
  chatHistory.innerHTML = '';
  if (messages.length === 0) {
    chatHistory.innerHTML = `
      <div class="message system">
        <div class="avatar">⚙️</div>
        <div class="content">
          Nenhuma mensagem encontrada.
        </div>
      </div>
    `;
    return;
  }
  messages.forEach(msg => {
    const isUser = msg.sender === 'Usuário';
    const role = isUser ? 'user' : 'bot';
    const avatar = isUser ? '👤' : '🤖';
    
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${role}`;

    const avatarDiv = document.createElement('div');
    avatarDiv.className = 'avatar';
    avatarDiv.textContent = avatar;

    const contentDiv = document.createElement('div');
    contentDiv.className = 'content';
    
    if (isUser) {
      contentDiv.textContent = msg.content;
    } else {
      contentDiv.innerHTML = renderMarkdown(msg.content);
    }

    messageDiv.appendChild(avatarDiv);
    messageDiv.appendChild(contentDiv);
    chatHistory.appendChild(messageDiv);
  });
  chatHistory.scrollTop = chatHistory.scrollHeight;
});

let selectedModel = null;


// Auto-resize textarea & handle slash commands
promptInput.addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = (this.scrollHeight) + 'px';
  sendBtn.disabled = this.value.trim().length === 0;

  // Slash command trigger
  if (this.value.includes('/model')) {
    slashPopup.style.display = 'block';
  } else {
    slashPopup.style.display = 'none';
  }
});

// Handle Slash Popup Selection
document.querySelectorAll('.popup-item').forEach(item => {
  item.addEventListener('click', () => {
    selectedModel = item.getAttribute('data-val');
    
    // Show badge
    modelBadge.textContent = `Modelo Ativo: ${item.textContent}`;
    modelBadge.style.display = 'block';
    
    // Clear /model from input
    promptInput.value = promptInput.value.replace(/\/model\s*/g, '');
    promptInput.focus();
    slashPopup.style.display = 'none';
  });
});

// Send on Enter (Shift+Enter for new line)
promptInput.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!sendBtn.disabled) sendPrompt();
  }
});

// Load installed engines on start
window.electronAPI.getInstalledEngines();

window.electronAPI.onInstalledEnginesList((engines) => {
  engineSelect.innerHTML = ''; // Clear current options
  
  engines.forEach(engine => {
    const option = document.createElement('option');
    option.value = engine.id;
    option.textContent = engine.name;
    engineSelect.appendChild(option);
  });
});

sendBtn.addEventListener('click', sendPrompt);

let currentBotMessageEl = null;   // the .content div
let accumulatedText = '';
let typingInterval = null;

// Configure marked to use highlight.js
marked.setOptions({
  highlight: function(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang }).value;
      } catch (__) {}
    }
    return hljs.highlightAuto(code).value; // fallback
  },
  breaks: true,
  gfm: true
});

function renderMarkdown(text) {
  // 1. Converte Markdown → HTML
  const rawHtml = marked.parse(text);
  // 2. Sanitiza via DOMPurify antes de injetar no DOM (previne XSS)
  return DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS: [
      'p','br','strong','em','b','i','u','s','code','pre','blockquote',
      'ul','ol','li','h1','h2','h3','h4','h5','h6',
      'table','thead','tbody','tr','th','td',
      'a','img','hr','span','div'
    ],
    ALLOWED_ATTR: ['href','src','alt','class','id','target','rel','style'],
    FORBID_TAGS: ['script','iframe','object','embed','form','input'],
    FORBID_ATTR: ['onerror','onload','onclick','onmouseover','onfocus','onblur'],
    ALLOW_DATA_ATTR: false
  });
}

// ── Typing indicator ─────────────────────────────────────────────
function showTypingIndicator(contentEl) {
  let dots = 0;
  contentEl.innerHTML = '<span class="typing-dots"><span></span><span></span><span></span></span>';
  return setInterval(() => {
    dots = (dots + 1) % 4;
    contentEl.querySelector('.typing-dots')?.setAttribute('data-dots', dots);
  }, 400);
}

function stopTypingIndicator() {
  if (typingInterval) {
    clearInterval(typingInterval);
    typingInterval = null;
  }
}

// ── Send prompt ───────────────────────────────────────────────────
function sendPrompt() {
  const text = promptInput.value.trim();
  if (!text) return;

  // Limita tamanho do prompt no frontend (50KB)
  if (text.length > 50000) {
    alert('Mensagem muito longa. Limite: 50.000 caracteres.');
    return;
  }

  appendMessage('user', '\u{1F464}', text);

  promptInput.value = '';
  promptInput.style.height = 'auto';
  sendBtn.disabled = true;

  accumulatedText = '';
  currentBotMessageEl = createBotMessage();

  // Show typing indicator immediately
  typingInterval = showTypingIndicator(currentBotMessageEl);

  const engine = engineSelect.value;
  window.electronAPI.sendPrompt({ text, engine, model: selectedModel });
}

function appendMessage(role, avatarEmoji, text) {
  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${role}`;

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = avatarEmoji;

  const content = document.createElement('div');
  content.className = 'content';
  if (text) content.textContent = text;

  messageDiv.appendChild(avatar);
  messageDiv.appendChild(content);
  chatHistory.appendChild(messageDiv);
  chatHistory.scrollTop = chatHistory.scrollHeight;

  return content;
}

function createBotMessage() {
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message bot';

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = '🤖';

  const content = document.createElement('div');
  content.className = 'content';

  messageDiv.appendChild(avatar);
  messageDiv.appendChild(content);
  chatHistory.appendChild(messageDiv);
  chatHistory.scrollTop = chatHistory.scrollHeight;

  return content;
}

// ── Stream response chunks ────────────────────────────────────────
window.electronAPI.onResponse((data) => {
  if (!currentBotMessageEl) return;

  // First chunk arrives: kill typing indicator
  stopTypingIndicator();

  accumulatedText += data;

  // Render accumulated text as markdown
  currentBotMessageEl.innerHTML = renderMarkdown(accumulatedText);
  chatHistory.scrollTop = chatHistory.scrollHeight;
});

// ── Process finished ──────────────────────────────────────────────
window.electronAPI.onProcessFinished((code) => {
  stopTypingIndicator();

  // If process finished with no output, show a generic error
  if (currentBotMessageEl && accumulatedText.trim() === '') {
    currentBotMessageEl.innerHTML = '<span style="color:#ff5f57">Nenhuma resposta recebida. Verifique os logs da aplicação.</span>';
  }

  currentBotMessageEl = null;
  accumulatedText = '';
  sendBtn.disabled = false;
});
