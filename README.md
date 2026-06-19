# egc-desktop

> Interface desktop para orquestrar agentes de IA via [EGC (Extended Global Context)](https://github.com/egchq/egc).

![egc-desktop](https://img.shields.io/badge/version-0.1.0-blue) ![Electron](https://img.shields.io/badge/Electron-42.x-9feaf9?logo=electron) ![License](https://img.shields.io/badge/license-MIT-green)

## O que é

**egc-desktop** é uma interface gráfica para desktop (Electron) que permite conversar com agentes de IA diretamente a partir de engines já instaladas no seu sistema — como [Antigravity CLI](https://antigravity.dev) ou [Gemini CLI](https://github.com/google-gemini/gemini-cli) — sem precisar configurar chaves de API adicionais.

A IA tem acesso total ao seu sistema via ferramentas MCP do EGC: pode rodar comandos no terminal, baixar arquivos, ler e editar arquivos, e muito mais.

## Funcionalidades

- 💬 Chat com histórico persistente (SQLite)
- 🤖 Suporte a múltiplas engines: Antigravity CLI, Gemini CLI
- 🛠️ Ferramentas MCP integradas (egc-guardian, egc-memory)
- ⚡ Execução de comandos no terminal local
- 📂 Gerenciamento de conversas (salvar, excluir, carregar)
- 🎨 Interface dark mode com markdown renderizado

## Pré-requisitos

- [Node.js](https://nodejs.org) 18+
- [Antigravity CLI](https://antigravity.dev) **ou** [Gemini CLI](https://github.com/google-gemini/gemini-cli) instalado e autenticado
- [EGC](https://github.com/egchq/egc) instalado globalmente (opcional, mas recomendado)

## Instalação

```bash
git clone https://github.com/SEU_USUARIO/egc-desktop.git
cd egc-desktop
npm install
npm start
```

## Uso

1. Selecione a engine de IA na barra lateral (Antigravity CLI ou Gemini CLI)
2. Digite `/model` para selecionar um modelo específico
3. Envie seu comando — a IA tem acesso ao seu sistema completo

## Estrutura

```
egc-desktop/
├── main.js         # Processo principal Electron + IPC
├── mcp-agent.js    # Delegação de prompts para o CLI instalado
├── renderer.js     # Interface do chat (frontend)
├── preload.js      # Bridge segura Electron ↔ renderer
├── index.html      # Estrutura HTML
└── styles.css      # Estilos dark mode
```

## Licença

MIT
