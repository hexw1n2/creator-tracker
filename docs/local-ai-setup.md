# Your local AI helper (free)

This sets up an AI assistant inside VS Code on your computer that can read and change the Creator Tracker app, explain how it works, and prepare fixes. It runs entirely on your computer. It's free and needs no account. Setup takes 30 to 45 minutes, mostly waiting for downloads.

**The pieces:** Ollama runs the AI model on your computer, Cline is the assistant inside VS Code, and GitHub Desktop sends finished changes to your live app.

## What to expect

- **It can:** change how the app looks or works, fix bugs in the app, explain the code, and draft database or server changes for you to review.
- **It can't, on purpose:** change your live database or server code. It writes those changes into a file, and you (or Claude) review them and apply them in Supabase. That way a mistake can't wipe your payment records.
- **It's slower and less capable than Claude.** Give it small, clear tasks, one at a time.

## Step 0: Check your computer's memory

- **Windows:** Settings → System → About → *Installed RAM*.
- **Mac:**  menu → About This Mac → *Memory*.

| Your memory | What to install |
|---|---|
| 8 GB | Too small for a useful local model. Use Claude instead (see the end of this guide). |
| 16 GB | `qwen2.5-coder:7b`. Fine for small edits and explanations, a bit slow. |
| 32 GB, or a graphics card with 12 GB+ | `qwen2.5-coder:14b`. Noticeably smarter. |
| 64 GB, or a Mac with 32 GB+ | `qwen2.5-coder:32b` or `gpt-oss:20b`. The best local option. |

Newer models come out often. If [ollama.com/search](https://ollama.com/search) lists a newer "coder" model in the same size, it's fine to use that instead.

## Step 1: Install Ollama and a model

1. Download and install Ollama from [ollama.com/download](https://ollama.com/download), then open it.
2. In Ollama's **Settings**, move the **Context length** slider up to **32k** (16k on a 16 GB computer). The default is too small for coding helpers.
3. Open **PowerShell** (Windows) or **Terminal** (Mac) and run the line for your size, for example:
   ```
   ollama pull qwen2.5-coder:7b
   ```
   It downloads 5 to 20 GB, so give it a few minutes.

## Step 2: Get the app's code onto your computer

1. Install [GitHub Desktop](https://desktop.github.com) and sign in with your GitHub account (hexw1n2).
2. **File → Clone repository**, pick **hexw1n2/creator-tracker** and click **Clone**. Remember the folder it uses.

## Step 3: Install VS Code and the two extensions

1. Install [VS Code](https://code.visualstudio.com) and open it.
2. **File → Open Folder** and pick the `creator-tracker` folder from Step 2.
3. Click the Extensions icon on the left (four squares), then search for and install **Cline** and **Live Server**.

## Step 4: Connect Cline to your local model

1. Click the Cline icon on the left and open its settings (gear icon).
2. Set **API Provider** to **Ollama**, Base URL to `http://localhost:11434`, and pick your model from the list.
3. Under **Features**, turn on **Use Compact Prompt**. This helps local models a lot.
4. Leave **Auto-approve** off. You want to see and approve every change.

Try it with this first message:

> Read AGENTS.md, then explain in plain words how adding a video works in this app.

## Using it day to day

1. **Ask for one small change**, for example: "Make the Paste link button say 'Add TikTok' instead". Cline shows each file change before making it. Click **Approve** only if it looks right, and ask it to explain anything you don't follow.
2. **Test it:** right-click `index.html` → **Open with Live Server**. Sign in and check the change works. This uses your real data, so be careful clicking Pay or Delete while testing.
3. **Publish it:** in GitHub Desktop, type a short summary at the bottom left, click **Commit to main**, then **Push origin**. The live app updates in about a minute. Close and reopen it on your phone.
4. **Undo a change:** GitHub Desktop → **History** → right-click the change → **Revert changes in commit** → **Push origin**.

**Database or server changes:** ask Cline to "write the SQL (or code) into a new file in a `proposals` folder and explain it". Don't paste it into Supabase unless you understand it. When in doubt, bring it to Claude to double-check.

## Safety rules

- The code on GitHub is **public**. Never paste passwords, Supabase secret or service-role keys, or API tokens into the AI chat or into any file.
- Keep auto-approve off.
- The rules the AI follows are in `AGENTS.md` and `.clinerules/`. Don't let it remove them.

## If you'd rather have a stronger helper

**Claude Code** (the desktop app or terminal version) works on this same folder and reads the same `AGENTS.md`. It's much more capable than a local model and can run tests and talk to Supabase, but it uses your Claude plan's usage instead of being free.
