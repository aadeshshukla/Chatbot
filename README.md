# Still — AI chat

A small, responsive AI chat app with a vanilla HTML/CSS/JavaScript frontend and an Express backend. It supports Gemini and Groq streaming responses.

## Run locally

1. Install Node.js 18 or newer.
2. Install the dependencies with `npm install`.
3. Copy `.env.example` to `.env` and add the API key for your provider. Groq is selected by default; set `AI_PROVIDER=gemini` to use Gemini.
4. Run `npm start` and open [http://localhost:3000](http://localhost:3000).

Set `GEMINI_MODEL` or `GROQ_MODEL` to change the model. The default Groq model is `llama-3.3-70b-versatile`. Keys stay in `.env`; the server never sends them to the browser. `.env` is ignored by Git.

The latest 12 messages are eligible for context; older turns are dropped until the rolling provider-specific character budget is met. Gemini defaults to 100,000 characters and Groq to 28,000. The server applies the same limit as a safeguard. This is a character estimate rather than an exact tokenizer, since token density varies by language and code. Replies are capped at 1,200 tokens and prompted to be concise. Set `CONTEXT_CHAR_BUDGET` and `MAX_COMPLETION_TOKENS` in `.env` to adjust these limits.

With Gemini selected, use the **Search web** button to let the model ground answers in Google Search. Results include clickable source links. Search is optional for each request.

Conversations are saved in this browser's local storage. Press Enter to send and Shift+Enter for a new line.
