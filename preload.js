const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  sendPrompt: (data) => ipcRenderer.send('send-prompt', data),
  onResponse: (callback) => ipcRenderer.on('receive-response', (_event, value) => callback(value)),
  onProcessFinished: (callback) => ipcRenderer.on('process-finished', (_event, code) => callback(code)),
  getInstalledEngines: () => ipcRenderer.send('get-installed-engines'),
  onInstalledEnginesList: (callback) => ipcRenderer.on('installed-engines-list', (_event, data) => callback(data)),
  saveConversation: (text) => ipcRenderer.send('save-conversation', text),
  deleteConversation: (id) => ipcRenderer.send('delete-conversation', id),
  getConversations: () => ipcRenderer.send('get-conversations'),
  loadConversation: (id) => ipcRenderer.send('load-conversation', id),
  onConversationsList: (callback) => ipcRenderer.on('conversations-list', (_event, data) => callback(data)),
  onConversationLoaded: (callback) => ipcRenderer.on('conversation-loaded', (_event, data) => callback(data)),
  openExternal: (url) => ipcRenderer.send('open-external', url)
});
