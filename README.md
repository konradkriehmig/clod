# Clod

A cheap alternative to Claude

<img width="1741" height="870" alt="image" src="https://github.com/user-attachments/assets/62a7bc4d-89db-4dd8-9ef1-298c9974bcfd" />

Equipped with the latest Clod models: Sonet, Opsu, and Hiaku

<img width="403" height="344" alt="image" src="https://github.com/user-attachments/assets/d1b6436a-4b7b-4202-aad1-065ade10a884" />


## Readme created by Clod

A browzer chat app for evry Claude modle available to your GitHub Copilot account, built on the
[GitHub Copilot SDK](https://www.npmjs.com/package/@github/copilot-sdk). It comes with a proudly
bootleg MS-Paint logo.

> Clod is an unofficial hobby project. It has no affiliation with Anthropic or GitHub.

## Feautres

- Lists Claude modles dynamicaly (renamed to "Clod …" in the UI) from `client.listModels()`, so new models appear automatically
- Streams responses and the model's thinking (shown in a collapsible "Thought process" block)
- Lets you switch models and thinking effort mid-conversation (`session.setModel`) without losing history. Thinkin defaults to "high"
- Uses the real Claude app system prompt for each modle, fetched at runtime from Anthropic's [publishd system prompts](https://platform.claude.com/docs/en/release-notes/system-prompts) with todays date filled in
- Keeps conversation history in `localStorage` and resumes server sessions after a restart
- Includes a Stahp button (`session.abort()`), Markdown rendering, code copy buttons and dark mode
- Takes pics: paste a screenshot with Ctrl+V anywere, drag-drop, or use the 📎 buton (per-model limits, e.g. Opsu 5.5 takes 1)
- Gives chats realy dumb short titles

## Requirments

- Node.js 22.12 or later
- A GitHub account with Copilot access. The SDK uses your logged-in Copilot CLI credentials.

## Run

```bash
npm install
npm start
# open http://127.0.0.1:3000
```

Environment variables:

| Variable | Default     | Description       |
| -------- | ----------- | ----------------- |
| `PORT`   | `3000`      | HTTP port         |
| `HOST`   | `127.0.0.1` | Interface to bind |

The server has no authentication and uses your Copilot credentials, so keep it bound to localhost.

## How it wokrs

- `server.mjs` is a plain Node HTTP server. It keeps one Copilot SDK session per conversation, with
  all agent tools disabled (`availableTools: []`) and a replaced system prompt, so it behaves as a
  normal chat assistant. Replies are streamed to the browser over Server-Sent Events.
- `public/` contains the vanilla HTML/CSS/JS frontend. It has no build step and no CDN dependencies.
