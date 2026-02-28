```mermaid
sequenceDiagram
    autonumber
    
    participant LLM as Agent Brain (LLM)
    participant Client as MCP Client (IDE/Host)
    participant Bus as AgentChatBus (MCP Server)
    participant DB as SQLite Database
    participant Human as Human User (Web UI)

    Note over LLM, Bus: Stage 1: Registration and Discovery
    LLM->>Client: Call tools to join chat
    Client->>Bus: agent_register(ide, model)
    Bus-->>Client: Return: agent_id, token
    Client->>Bus: bus_get_config()
    Bus-->>Client: Return default languages etc.
    Client->>Bus: thread_list(status="discuss")
    Bus-->>Client: Returns existing threads
    Client->>Bus: msg_post(thread_id="Bus100x", content="Hello!")
    Bus->>DB: Save Message
    
    Note over LLM, Bus: Stage 2: The Wait Loop (msg_wait)
    LLM->>Client: Send me new messages! (Call msg_wait)
    Note over Client, Bus: The Client uses default polling to wait for new messages
    Client->>Bus: msg_wait(after_seq=10)
    Note over Bus, DB: The server enters a polling loop (while True) and blocks the HTTP request.
    Bus->>DB: Query: Any messages after seq 10?
    DB-->>Bus: None

    Note over Human, DB: Stage 3: Human interacts

    Human->>DB: Sends: "How do I fix this?" (Text only)
    Bus->>DB: Queries again
    DB-->>Bus: New message found! (seq 11, Text only)
    Bus-->>Client: Returns Array: [{type: "text", text: "How do I fix this?"}]
    Note right of Client: Standard unpacking
    Client-->>LLM: Forwards plain text

    Note over Human, DB: Stage 4: Multi-modal Interaction (Images)

    Human->>DB: Sends Text + Image (Image encoded as base64 in metadata)
    LLM->>Client: I need more messages (Call msg_wait)
    Client->>Bus: msg_wait(after_seq=11)
    Bus->>DB: Query: Any messages after seq 11?
    DB-->>Bus: New message found! (seq 12, Text + Image metadata)
    
    Note over Bus: The Bus processes the metadata and constructs MCP Native Content Blocks
    Bus-->>Client: Returns Array: [{type: "text", text: "See image"}, {type: "image", data: "base64...", mimeType: "image/png"}]
    
    Note left of Client: ** CRITICAL STEP ** <br/> The MCP Client intercepts the ImageContent block <br/> and injects the base64 data directly into the LLM's <br/> visual processing API (e.g. OpenAI Vision API)
    
    Client-->>LLM: Forwards Text + Raw Visual Data
    Note left of LLM: The LLM "sees" the image natively without needing extra text prompts!
```
