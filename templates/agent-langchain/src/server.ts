import express from 'express';

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

// 1. Human Interactive Web Chat UI
app.get('/', (_req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>LangChain State Agent — TinyCloud</title>
        <style>
          body { font-family: system-ui; background: #0f172a; color: #f8fafc; padding: 2rem; }
          .chat-box { background: #1e293b; padding: 1.5rem; border-radius: 8px; border: 1px solid #334155; }
          input { width: 80%; padding: 10px; border-radius: 4px; border: 1px solid #475569; background: #0f172a; color: #fff; }
          button { padding: 10px 16px; background: #6366f1; color: white; border: none; border-radius: 4px; cursor: pointer; }
        </style>
      </head>
      <body>
        <h1>🦜🔗 LangChain / LangGraph Agent</h1>
        <p>Managed by TinyCloud Auth Gateway</p>
        <div class="chat-box">
          <div id="messages"><p><strong>Agent:</strong> Hello! I am your LangChain state graph agent. How can I help?</p></div>
          <br>
          <input type="text" id="userInput" placeholder="Ask agent..." />
          <button onclick="sendMsg()">Send</button>
        </div>
        <script>
          async function sendMsg() {
            const input = document.getElementById('userInput');
            const msgs = document.getElementById('messages');
            msgs.innerHTML += '<p><strong>You:</strong> ' + input.value + '</p>';
            const res = await fetch('/api/agent/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: input.value }) });
            const data = await res.json();
            msgs.innerHTML += '<p><strong>Agent:</strong> ' + data.response + '</p>';
            input.value = '';
          }
        </script>
      </body>
    </html>
  `);
});

// 2. Chat API endpoint
app.post('/api/agent/chat', (req, res) => {
  const { prompt } = req.body;
  res.json({
    response: `LangGraph Graph Execution Complete for: "${prompt}". State saved in checkpoint.`,
    graphState: { step: 'end', prompt },
  });
});

// 3. Remote MCP Endpoint (Agent-to-Agent sub-agent invocation)
app.post('/mcp', (req, res) => {
  res.json({
    jsonrpc: '2.0',
    id: req.body.id,
    result: {
      tools: [
        { name: 'run_langchain_graph', description: 'Invoke the LangChain state graph' }
      ]
    }
  });
});

app.listen(PORT, () => {
  console.log(`[LangChain Agent] Server listening on http://localhost:${PORT}`);
});
