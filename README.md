# Clod

A cheap alternative to Claude

<img width="1741" height="870" alt="image" src="https://github.com/user-attachments/assets/62a7bc4d-89db-4dd8-9ef1-298c9974bcfd" />

Equipped with the latest Clod models: Sonet, Opsu, and Hiaku

<img width="403" height="344" alt="image" src="https://github.com/user-attachments/assets/d1b6436a-4b7b-4202-aad1-065ade10a884" />

Transparent thought process

<img width="1023" height="368" alt="image" src="https://github.com/user-attachments/assets/1a35e3e5-dd60-4a5c-8062-bdaf75e80794" />



## Readme created by Clod

its a chat thing in the browzer. u type words, Clod types words back. it uses evry Claude modle ur GitHub Copilot has, thru the [GitHub Copilot SDK](https://www.npmjs.com/package/@github/copilot-sdk) (big computer word, dont worry abt it). the logo was made in MS Paint by a profesional (me).

> Clod is not Anthropic. Clod is not GitHub. Clod is just Clod. pls dont sue Clod.

## Stuf it does

- has modles. they are called Sonet, Opsu and Hiaku. new ones show up by them selfs, its like magic
- words come out one at a time so it looks like its typing. very advanced
- shows the thinky part in a box u can open. sometimes it doesnt think. same tbh
- u can change the modle in the middle and it still remembers stuff (most of the time)
- thinkin is set to "high" bc we want it SMART
- uses the reel Claude app system prompt, Clod downloads it from Anthropic evry day and also tells it the date so it knows what day it is
- remembers ur chats in the browzer. dont clear ur cookies or it forgets everything
- big Stahp button if Clod is talking to much
- copy buttons on the code. also dark mode for vampires
- u can paste screenshots with Ctrl+V. or drag them. or the paperclip 📎. Opsu 5.5 can only look at 1 pic at a time bc its old and its eyes are tired
- gives ur chats realy good names like "bike chayn"
- VOICE MODE 🎙. press the mic and just tlak to Clod. it tlaks back (with ur browzers robot voice, works best in Edge). tap the orange blob to make it shut up. Anthropic doesnt put the voice system prompt online so Clod made up its own little one

## U need

- Node.js 22.12 or newer (older ones are bad, they dont work)
- GitHub Copilot. u have to be logged in to the Copilot CLI first. Clod cant log in for u, Clod has no hands

## How to turn it on

```bash
npm install
npm start
# then go to http://127.0.0.1:3000 in ur browzer
```

knobs u can turn:

| Knob   | Normal      | Wat it does           |
| ------ | ----------- | --------------------- |
| `PORT` | `3000`      | the numbr at the end  |
| `HOST` | `127.0.0.1` | where it lives        |

⚠ Clod has no pasword and uses YOUR Copilot account. keep it on ur own computer (`127.0.0.1`) or strangers will talk to Clod on ur bill

## How it wokrs (we think)

- `server.mjs` is the brain. evry chat gets its own Copilot sesion. we took away all the tools so it cant touch ur files, it can only talk. the words get beamed to the browzer with Server-Sent Events (wires)
- `public/` is the face. just HTML, CSS and JS. no build step. no framworks. no idea what those are anyway
