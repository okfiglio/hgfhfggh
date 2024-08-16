const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const { Storage } = require("megajs");
const { ChatGroq } = require("@langchain/groq");
const { ConversationChain } = require("langchain/chains");
const {
  ChatPromptTemplate,
  HumanMessagePromptTemplate,
  MessagesPlaceholder,
} = require("@langchain/core/prompts");
const { SystemMessage } = require("@langchain/core/messages");
const { BufferMemory } = require("langchain/memory");
const cors = require("cors");
const multer = require("multer");
const axios = require("axios");
const FormData = require("form-data");

const upload = multer({ storage: multer.memoryStorage() });

const app = express();
app.use(express.json());
app.use(cors());

const JWT_SECRET_KEY = "hola"; // Change this to a secure secret key
const MEGA_EMAIL = "buongiornissimo4@gmail.com";
const MEGA_PASSWORD = "99Dp99Dp..";
TTS_SERVER_URL = ""; // Update this with your actual TTS server URL

class ChatServer {
  constructor() {
    this.users = {};
    this.megaStorage = null;
    this.characters = [];
    this.conversations = {};
    this.groqApiKeys = [
      "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",
    ];
    this.currentKeyIndex = 0;
    this.model = "llama-3.1-70b-versatile";
    this.responseHistory = {};
    this.FirstTime = true;
    this.currentIndex = 0;
    this.DeleteresponseHistory = false;
    this.ttsServerUrlReady = false;
    this.ttsServerActive = false;
    this.searchingForTTSServer = false;
    this.initMega();
    this.startTTSServerSearch();
    this.startAutoSave();
  }

  async initMega() {
    try {
      this.megaStorage = new Storage({
        email: MEGA_EMAIL,
        password: MEGA_PASSWORD,
      });

      await this.megaStorage.ready;
      console.log("Connected to MEGA");

      if (!this.megaStorage.root) {
        console.error("MEGA root folder not available");
        return;
      }

      await this.loadUsers();
      await this.loadCharacters();
    } catch (error) {
      console.error("Failed to connect to MEGA:", error);
    }
  }

  async loadUsers() {
    if (!this.megaStorage || !this.megaStorage.root) {
      console.error("MEGA storage or root folder not initialized");
      return;
    }

    try {
      const usersFile = this.megaStorage.root.children.find(
        (file) => file.name === "users.json"
      );
      if (usersFile) {
        const buffer = await usersFile.downloadBuffer();
        this.users = JSON.parse(buffer.toString("utf-8"));
      } else {
        console.log("users.json not found, initializing empty users object");
        this.users = {};
      }
    } catch (error) {
      console.error("Error loading users:", error);
      this.users = {};
    }
  }

  async saveUsers() {
    const usersJson = JSON.stringify(this.users);
    await this.megaStorage.upload("users.json", Buffer.from(usersJson))
      .complete;
  }

  async loadCharacters() {
    if (!this.megaStorage || !this.megaStorage.root) {
      console.error("MEGA storage or root folder not initialized");
      return;
    }

    try {
      const charactersFile = this.megaStorage.root.children.find(
        (file) => file.name === "characters.json"
      );
      if (charactersFile) {
        const buffer = await charactersFile.downloadBuffer();
        this.characters = JSON.parse(buffer.toString("utf-8"));
      } else {
        console.log(
          "characters.json not found, initializing empty characters array"
        );
        this.characters = [];
      }
    } catch (error) {
      console.error("Error loading characters:", error);
      this.characters = [];
    }
  }

  async saveCharacters() {
    const charactersJson = JSON.stringify(this.characters);
    const oldFile = this.megaStorage.root.children.find(
      (file) => file.name === "characters.json"
    );
    if (oldFile) {
      await oldFile.delete();
    }
    await this.megaStorage.upload(
      "characters.json",
      Buffer.from(charactersJson)
    ).complete;
  }

  async uploadCharacterImage(characterName, imageBuffer) {
    const filename = `character_image_${characterName}_${Date.now()}.jpg`;
    const uploadedFile = await this.megaStorage.upload(filename, imageBuffer)
      .complete;
    const imageLink = await uploadedFile.link();
    return { filename, imageLink };
  }

  async updateCharacterImage(characterName, imageBuffer) {
    const character = this.characters.find((c) => c.name === characterName);
    if (!character) {
      throw new Error("Character not found");
    }

    if (character.imageFilename) {
      const oldFile = this.megaStorage.root.children.find(
        (file) => file.name === character.imageFilename
      );
      if (oldFile) {
        await oldFile.delete();
      }
    }

    const { filename, imageLink } = await this.uploadCharacterImage(
      characterName,
      imageBuffer
    );

    character.imageFilename = filename;
    character.imageLink = imageLink;

    await this.saveCharacters();

    return { filename, imageLink };
  }

  async getCharacterImage(characterName) {
    const character = this.characters.find((c) => c.name === characterName);
    if (!character || !character.imageFilename) {
      return null;
    }

    const file = this.megaStorage.root.children.find(
      (file) => file.name === character.imageFilename
    );
    if (!file) {
      return null;
    }

    return await file.downloadBuffer();
  }

  setupAI(character) {
    const groqChat = this.getGroqChat(
      this.groqApiKeys[this.currentKeyIndex],
      this.model
    );

    const systemPrompt = `You are ${character.name}, ${character.description}. Respond to the user's messages in character.`;

    const memory = new BufferMemory({
      returnMessages: true,
      memoryKey: "history",
    });

    const conversation = new ConversationChain({
      llm: groqChat,
      verbose: true,
      memory: memory,
      prompt: ChatPromptTemplate.fromMessages([
        new SystemMessage(systemPrompt),
        new MessagesPlaceholder("history"),
        HumanMessagePromptTemplate.fromTemplate("{input}"),
      ]),
    });

    return { conversation, memory };
  }

  getGroqChat(apiKey, model) {
    return new ChatGroq({ apiKey: apiKey, modelName: model });
  }

  async getAIResponse(userInput, conversation, username, regenerate = false) {
    const maxRetries = this.groqApiKeys.length;
    let retries = 0;
    while (retries < maxRetries) {
      try {
        if (!this.responseHistory[username]) {
          this.responseHistory[username] = [];
        }

        if (regenerate) {
          conversation.memory.chatHistory.messages.pop();
          conversation.memory.chatHistory.messages.pop();
        }

        const response = await conversation.predict({ input: userInput });
        console.log(`\nToken usage: ${response.totalTokens} tokens`);

        this.responseHistory[username].push(response);

        return response;
      } catch (error) {
        if (error.name === "RateLimitError") {
          console.log(
            `Rate limit reached. Switching API key. (Attempt ${
              retries + 1
            }/${maxRetries})`
          );
          this.currentKeyIndex =
            (this.currentKeyIndex + 1) % this.groqApiKeys.length;
          conversation.llm = this.getGroqChat(
            this.groqApiKeys[this.currentKeyIndex],
            this.model
          );
          const retryAfter = error.response?.data?.["retry-after"] || 10;
          await new Promise((resolve) =>
            setTimeout(resolve, retryAfter * 1000)
          );
          retries++;
        } else {
          throw error;
        }
      }
    }
    return "I apologize, but I'm currently unable to process your request due to API limitations. Please try again later.";
  }

  async regenerateResponse(username) {
    if (!this.conversations[username]) {
      throw new Error("No active conversation for this user");
    }

    const conversation = this.conversations[username].conversation;
    const userInput =
      conversation.memory.chatHistory.messages[
        conversation.memory.chatHistory.messages.length - 2
      ].content;

    return await this.getAIResponse(userInput, conversation, username, true);
  }

  async navigateResponses(username, direction) {
    if (!this.conversations[username]) {
      throw new Error("No active conversation for this user");
    }

    if (this.DeleteresponseHistory) {
      this.responseHistory[username] = [];
      this.DeleteresponseHistory = false;
    }

    if (
      !this.responseHistory[username] ||
      this.responseHistory[username].length === 0
    ) {
      throw new Error("No response history available");
    }

    const conversation = this.conversations[username].conversation;
    const historyLength = this.responseHistory[username].length;

    if (this.FirstTime) {
      this.currentIndex =
        this.conversations[username].currentIndex || historyLength - 1;
      this.FirstTime = false;
    }

    if (direction === "previous") {
      if (this.currentIndex > 0) {
        this.currentIndex--;
        const previousResponse =
          this.responseHistory[username][this.currentIndex];
        conversation.memory.chatHistory.messages.pop();
        await conversation.memory.chatHistory.addAIChatMessage(
          previousResponse
        );
        this.conversations[username].currentIndex = this.currentIndex;
        return previousResponse;
      } else {
        throw new Error("No previous responses available");
      }
    } else if (direction === "next") {
      if (this.currentIndex < historyLength - 1) {
        this.currentIndex++;
        const nextResponse = this.responseHistory[username][this.currentIndex];
        conversation.memory.chatHistory.messages.pop();
        await conversation.memory.chatHistory.addAIChatMessage(nextResponse);
        this.conversations[username].currentIndex = this.currentIndex;
        return nextResponse;
      } else {
        throw new Error("Already at the most recent response");
      }
    } else {
      throw new Error("Invalid direction");
    }
  }

  async addNewUserInput(username, userInput) {
    if (!this.conversations[username]) {
      throw new Error("No active conversation for this user");
    }

    this.responseHistory[username] = [];
    this.FirstTime = true;

    const conversation = this.conversations[username].conversation;
    return await this.getAIResponse(userInput, conversation, username);
  }

  async deleteLastMessage(username) {
    if (!this.conversations[username]) {
      throw new Error("No active conversation for this user");
    }

    const conversation = this.conversations[username];
    const messages = conversation.memory.chatHistory.messages;

    if (messages.length < 2) {
      throw new Error("Not enough messages to delete");
    }

    messages.splice(-2);

    conversation.memory.chatHistory.messages = messages;

    this.DeleteresponseHistory = true;

    return { msg: "Last message deleted successfully" };
  }

  async loadConversation(username, characterName, conversationId) {
    if (!this.megaStorage || !this.megaStorage.root) {
      console.error("MEGA storage or root folder not initialized");
      return null;
    }

    try {
      const fileName = `conversation_${conversationId}.json`;
      const file = this.megaStorage.root.children.find(
        (f) => f.name === fileName
      );

      if (!file) {
        console.log(`Conversation file not found: ${fileName}`);
        return null;
      }

      const buffer = await file.downloadBuffer();
      const conversationData = JSON.parse(buffer.toString("utf-8"));

      const character = this.characters.find((c) => c.name === characterName);
      const { conversation, memory } = this.setupAI(character);

      for (const msg of conversationData.messages) {
        if (msg.sender === "User") {
          await memory.chatHistory.addUserMessage(msg.content);
        } else {
          await memory.chatHistory.addAIChatMessage(msg.content);
        }
      }

      return {
        id: conversationId,
        conversation,
        memory,
        character,
        messages: conversationData.messages,
      };
    } catch (error) {
      console.error("Error loading conversation:", error);
      return null;
    }
  }

  async saveConversation(username, characterName) {
    if (!this.conversations[username]) {
      console.log(`No active conversation for user ${username}`);
      return;
    }

    const conversation = this.conversations[username];
    const conversationId =
      conversation.id || `${username}_${characterName}_${Date.now()}`;
    const fileName = `conversation_${conversationId}.json`;

    const simplifiedMessages = conversation.memory.chatHistory.messages.map(
      (msg, index) => ({
        sender: index % 2 === 0 ? "User" : "AI",
        content: msg.content,
      })
    );

    const conversationData = {
      id: conversationId,
      username: username,
      characterName: characterName,
      messages: simplifiedMessages,
      timestamp: new Date().toISOString(),
    };

    try {
      const existingFile = this.megaStorage.root.children.find(
        (file) => file.name === fileName
      );
      if (existingFile) {
        console.log(`Overwriting existing conversation file: ${fileName}`);
        await existingFile.delete();
      }

      const buffer = Buffer.from(JSON.stringify(conversationData, null, 2));
      await this.megaStorage.upload(fileName, buffer).complete;
      console.log(`Conversation saved: ${fileName}`);
      this.DeleteresponseHistory = true;
    } catch (error) {
      console.error("Error saving conversation:", error);
    }
  }

  async getConversations(username, characterName) {
    if (!this.megaStorage || !this.megaStorage.root) {
      console.error("MEGA storage or root folder not initialized");
      return [];
    }

    try {
      const conversationFiles = this.megaStorage.root.children.filter((file) =>
        file.name.startsWith(`conversation_${username}_${characterName}_`)
      );

      const conversations = await Promise.all(
        conversationFiles.map(async (file) => {
          const buffer = await file.downloadBuffer();
          return JSON.parse(buffer.toString("utf-8"));
        })
      );

      return conversations.sort(
        (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
      );
    } catch (error) {
      console.error("Error getting conversations:", error);
      return [];
    }
  }

  async uploadCharacterVoice(characterName, voiceBuffer) {
    const filename = `character_voice_${characterName}_${Date.now()}.wav`;
    const uploadedFile = await this.megaStorage.upload(filename, voiceBuffer)
      .complete;
    const voiceLink = await uploadedFile.link();
    return { filename, voiceLink };
  }

  async updateCharacterVoice(characterName, voiceBuffer) {
    const character = this.characters.find((c) => c.name === characterName);
    if (!character) {
      throw new Error("Character not found");
    }

    if (character.voiceFilename) {
      const oldFile = this.megaStorage.root.children.find(
        (file) => file.name === character.voiceFilename
      );
      if (oldFile) {
        await oldFile.delete();
      }
    }

    const { filename, voiceLink } = await this.uploadCharacterVoice(
      characterName,
      voiceBuffer
    );

    character.voiceFilename = filename;
    character.voiceLink = voiceLink;

    await this.saveCharacters();

    return { filename, voiceLink };
  }

  async getCharacterVoice(characterName) {
    const character = this.characters.find((c) => c.name === characterName);
    if (!character || !character.voiceFilename) {
      return null;
    }

    const file = this.megaStorage.root.children.find(
      (file) => file.name === character.voiceFilename
    );
    if (!file) {
      return null;
    }

    return await file.downloadBuffer();
  }

  async shutdownTTSServer() {
    if (this.ttsServerActive && TTS_SERVER_URL) {
      try {
        await axios.post(`${TTS_SERVER_URL}/close`);
        console.log("TTS server shutdown request sent successfully");
      } catch (error) {
        console.error("Error shutting down TTS server:", error);
      } finally {
        this.ttsServerActive = false;
        this.ttsServerUrlReady = false;
        TTS_SERVER_URL = "";
        this.restartTTSServerSearch();
      }
    }
  }

  restartTTSServerSearch() {
    console.log("Restarting TTS server search...");
    this.searchingForTTSServer = false;
    this.startTTSServerSearch();
  }

  startTTSServerSearch() {
    if (!this.searchingForTTSServer) {
      this.searchingForTTSServer = true;
      this.checkNgrokUrlFile();
    }
  }

  async generateTTS(text, voiceBuffer, language = "en") {
    if (!this.ttsServerUrlReady) {
      throw new Error("TTS server URL not yet available");
    }

    const formData = new FormData();
    formData.append("audio", voiceBuffer, { filename: "voice.wav" });
    formData.append("text", text);
    formData.append("language", language);

    try {
      const response = await axios.post(TTS_SERVER_URL + "/tts", formData, {
        headers: formData.getHeaders(),
        responseType: "arraybuffer",
      });

      return response.data;
    } catch (error) {
      console.error("Error generating TTS:", error);
      this.restartTTSServerSearch();
      throw error;
    }
  }

  async checkNgrokUrlFile() {
    while (this.searchingForTTSServer) {
      try {
        const file = this.megaStorage.root.children.find(
          (file) => file.name === "ngrok_urls.json"
        );
        if (file) {
          console.log(
            "ngrok_urls.json found. Waiting 5 seconds before reading..."
          );
          await new Promise((resolve) => setTimeout(resolve, 5000));

          const buffer = await file.downloadBuffer();
          const content = JSON.parse(buffer.toString("utf-8"));

          if (content.ngrok_url) {
            TTS_SERVER_URL = content.ngrok_url;
            this.ttsServerUrlReady = true;
            this.ttsServerActive = true;
            console.log(`TTS_SERVER_URL updated to: ${TTS_SERVER_URL}`);
            this.searchingForTTSServer = false;
          }

          await file.delete();
        }
      } catch (error) {
        console.error("Error checking for ngrok_urls.json:", error);
      }

      if (this.searchingForTTSServer) {
        await new Promise((resolve) => setTimeout(resolve, 10000));
        console.log("Checking for ngrok_urls.json...");
      }
    }
  }

  async saveCharacters() {
    const charactersJson = JSON.stringify(this.characters, null, 2);
    const oldFile = this.megaStorage.root.children.find(
      (file) => file.name === "characters.json"
    );
    if (oldFile) {
      await oldFile.delete();
    }
    await this.megaStorage.upload(
      "characters.json",
      Buffer.from(charactersJson)
    ).complete;
  }

  startAutoSave() {
    setInterval(async () => {
      await this.saveCharacters();
      for (const username in this.conversations) {
        const conversation = this.conversations[username];
        if (
          conversation &&
          conversation.character &&
          conversation.character.name
        ) {
          await this.saveConversation(username, conversation.character.name);
        } else {
          console.error(`Invalid conversation structure for user ${username}`);
          await this.saveConversation(username, "unknown_character");
        }
      }
    }, 300000); // Auto-save every 5 minutes
  }

  async cleanup() {
    await this.saveCharacters();
    for (const username in this.conversations) {
      const conversation = this.conversations[username];
      if (
        conversation &&
        conversation.character &&
        conversation.character.name
      ) {
        await this.saveConversation(username, conversation.character.name);
      } else {
        console.error(`Invalid conversation structure for user ${username}`);
        await this.saveConversation(username, "unknown_character");
      }
    }
  }
}

const chatServer = new ChatServer();

app.post("/register", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ msg: "Missing username or password" });
  }
  if (username in chatServer.users) {
    return res.status(400).json({ msg: "Username already exists" });
  }
  chatServer.users[username] = bcrypt.hashSync(password, 10);
  await chatServer.saveUsers();
  return res.status(201).json({ msg: "User created successfully" });
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ msg: "Missing username or password" });
  }
  if (
    !(username in chatServer.users) ||
    !bcrypt.compareSync(password, chatServer.users[username])
  ) {
    return res.status(401).json({ msg: "Bad username or password" });
  }
  const accessToken = jwt.sign({ username }, JWT_SECRET_KEY);
  return res.json({ accessToken });
});

app.get("/characters", authenticateToken, (req, res) => {
  res.json(chatServer.characters);
});

app.get(
  "/conversations/:character_name",
  authenticateToken,
  async (req, res) => {
    const { username } = req.user;
    const { character_name } = req.params;

    try {
      const conversations = await chatServer.getConversations(
        username,
        character_name
      );
      res.json(conversations);
    } catch (error) {
      res
        .status(500)
        .json({ msg: "Error fetching conversations", error: error.message });
    }
  }
);

app.post("/create_character", authenticateToken, async (req, res) => {
  const { name, traits, backstory } = req.body;
  if (!name || !traits || !backstory) {
    return res
      .status(400)
      .json({ msg: "Missing character name or traits or description" });
  }
  if (chatServer.characters.some((c) => c.name === name)) {
    return res.status(400).json({ msg: "Character name already exists" });
  }
  chatServer.characters.push({ name, traits, backstory });
  await chatServer.saveCharacters();
  return res.status(201).json({ msg: "Character created successfully" });
});

app.post("/delete_character", authenticateToken, async (req, res) => {
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ msg: "Missing character name" });
  }

  try {
    const characterIndex = chatServer.characters.findIndex(
      (c) => c.name === name
    );
    if (characterIndex === -1) {
      return res.status(404).json({ msg: "Character not found" });
    }

    const character = chatServer.characters[characterIndex];

    if (character.imageFilename) {
      const imageFile = chatServer.megaStorage.root.children.find(
        (file) => file.name === character.imageFilename
      );
      if (imageFile) {
        await imageFile.delete();
      }
    }

    if (character.voiceFilename) {
      const voiceFile = chatServer.megaStorage.root.children.find(
        (file) => file.name === character.voiceFilename
      );
      if (voiceFile) {
        await voiceFile.delete();
      }
    }

    const conversationFiles = chatServer.megaStorage.root.children.filter(
      (file) =>
        file.name.startsWith(`conversation_`) && file.name.includes(`_${name}_`)
    );

    for (const file of conversationFiles) {
      await file.delete();
    }

    chatServer.characters.splice(characterIndex, 1);

    await chatServer.saveCharacters();

    return res.json({
      msg: "Character and all associated files deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting character:", error);
    return res
      .status(500)
      .json({ msg: "Error deleting character", error: error.message });
  }
});

app.post(
  "/upload_character_image",
  authenticateToken,
  upload.single("image"),
  async (req, res) => {
    const { character_name } = req.body;
    if (!character_name || !req.file) {
      return res.status(400).json({ msg: "Missing character name or image" });
    }

    try {
      const { filename, imageLink } = await chatServer.updateCharacterImage(
        character_name,
        req.file.buffer
      );
      return res.json({
        msg: "Image uploaded successfully",
        filename,
        imageLink,
      });
    } catch (error) {
      return res
        .status(500)
        .json({ msg: "Error uploading image", error: error.message });
    }
  }
);

app.get(
  "/character_image/:character_name",
  authenticateToken,
  async (req, res) => {
    const { character_name } = req.params;
    try {
      const imageBuffer = await chatServer.getCharacterImage(character_name);
      if (!imageBuffer) {
        return res.status(404).json({ msg: "Character image not found" });
      }
      res.setHeader("Content-Type", "image/jpeg");
      res.send(imageBuffer);
    } catch (error) {
      console.error("Error fetching character image:", error);
      res.status(500).json({ msg: "Error fetching character image" });
    }
  }
);

app.post("/start_conversation", authenticateToken, async (req, res) => {
  const { username } = req.user;
  const { character_name, conversation_id } = req.body;

  try {
    let conversation;
    let messages = [];
    let systemPrompt = "";

    if (conversation_id === "new") {
      const character = chatServer.characters.find(
        (c) => c.name === character_name
      );
      conversation = chatServer.setupAI(character);
      conversation.id = `${username}_${character_name}_${Date.now()}`;
      systemPrompt = `You are ${character.name}, ${character.description}. Respond to the user's messages in character.`;
    } else {
      conversation = await chatServer.loadConversation(
        username,
        character_name,
        conversation_id
      );
      if (!conversation) {
        return res.status(404).json({ msg: "Conversation not found" });
      }
      messages = conversation.messages;
      const character = chatServer.characters.find(
        (c) => c.name === character_name
      );
      systemPrompt = `You are ${character.name}, ${character.description}. Respond to the user's messages in character.`;
    }

    chatServer.conversations[username] = conversation;

    res.json({
      msg:
        conversation_id === "new"
          ? "New conversation started"
          : "Conversation resumed",
      conversationId: conversation.id,
      messages: [{ sender: "system", content: systemPrompt }, ...messages],
    });
  } catch (error) {
    console.error("Error starting/resuming conversation:", error);
    res.status(500).json({
      msg: "Error starting/resuming conversation",
      error: error.message,
    });
  }
});

app.post("/send_message", authenticateToken, async (req, res) => {
  const { username } = req.user;
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ msg: "Missing message" });
  }
  if (!(username in chatServer.conversations)) {
    return res.status(400).json({ msg: "No active conversation" });
  }
  try {
    const response = await chatServer.addNewUserInput(username, message);
    return res.json({ response });
  } catch (error) {
    return res
      .status(500)
      .json({ msg: "Error processing message", error: error.message });
  }
});

app.post("/regenerate_response", authenticateToken, async (req, res) => {
  const { username } = req.user;
  try {
    const response = await chatServer.regenerateResponse(username);
    return res.json({ response });
  } catch (error) {
    return res
      .status(500)
      .json({ msg: "Error regenerating response", error: error.message });
  }
});

app.post("/navigate_responses", authenticateToken, async (req, res) => {
  const { username } = req.user;
  const { direction } = req.body;
  if (!direction || (direction !== "previous" && direction !== "next")) {
    return res.status(400).json({ msg: "Invalid direction" });
  }
  try {
    const response = await chatServer.navigateResponses(username, direction);
    return res.json({ response });
  } catch (error) {
    return res
      .status(500)
      .json({ msg: "Error navigating responses", error: error.message });
  }
});

app.post("/delete_last_message", authenticateToken, async (req, res) => {
  const { username } = req.user;
  try {
    const result = await chatServer.deleteLastMessage(username);
    res.json(result);
  } catch (error) {
    res.status(400).json({ msg: error.message });
  }
});

app.post("/end_conversation", authenticateToken, async (req, res) => {
  const { username } = req.user;
  try {
    if (username in chatServer.conversations) {
      const conversation = chatServer.conversations[username];
      if (
        conversation &&
        conversation.character &&
        conversation.character.name
      ) {
        await chatServer.saveConversation(
          username,
          conversation.character.name
        );
      } else {
        console.error(`Invalid conversation structure for user ${username}`);
        await chatServer.saveConversation(username, "unknown_character");
      }
      delete chatServer.conversations[username];
      return res.json({ msg: "Conversation ended and saved" });
    } else {
      return res.status(400).json({ msg: "No active conversation to end" });
    }
  } catch (error) {
    console.error("Error ending conversation:", error);
    return res
      .status(500)
      .json({ msg: "Error ending conversation", error: error.message });
  }
});

app.post(
  "/upload_character_voice",
  authenticateToken,
  upload.single("voice"),
  async (req, res) => {
    const { character_name } = req.body;
    if (!character_name || !req.file) {
      return res
        .status(400)
        .json({ msg: "Missing character name or voice file" });
    }

    try {
      const { filename, voiceLink } = await chatServer.updateCharacterVoice(
        character_name,
        req.file.buffer
      );
      return res.json({
        msg: "Voice uploaded successfully",
        filename,
        voiceLink,
      });
    } catch (error) {
      return res
        .status(500)
        .json({ msg: "Error uploading voice", error: error.message });
    }
  }
);

app.get(
  "/character_voice/:character_name",
  authenticateToken,
  async (req, res) => {
    const { character_name } = req.params;
    try {
      const voiceBuffer = await chatServer.getCharacterVoice(character_name);
      if (!voiceBuffer) {
        return res.status(404).json({ msg: "Character voice not found" });
      }
      res.setHeader("Content-Type", "audio/wav");
      res.send(voiceBuffer);
    } catch (error) {
      console.error("Error fetching character voice:", error);
      res.status(500).json({ msg: "Error fetching character voice" });
    }
  }
);

app.post("/generate_tts", authenticateToken, async (req, res) => {
  const { character_name, text, language } = req.body;
  if (!character_name || !text) {
    return res.status(400).json({ msg: "Missing character name or text" });
  }

  try {
    if (!chatServer.ttsServerUrlReady) {
      return res.status(503).json({ msg: "TTS server URL not yet available" });
    }

    const voiceBuffer = await chatServer.getCharacterVoice(character_name);
    if (!voiceBuffer) {
      return res.status(404).json({ msg: "Character voice not found" });
    }

    const ttsAudio = await chatServer.generateTTS(text, voiceBuffer, language);

    res.setHeader("Content-Type", "audio/wav");
    res.send(ttsAudio);
  } catch (error) {
    console.error("Error generating TTS:", error);
    res.status(500).json({ msg: "Error generating TTS", error: error.message });
  }
});

app.post("/application_closed", authenticateToken, async (req, res) => {
  try {
    await chatServer.cleanup();
    await chatServer.shutdownTTSServer();
    res.json({ msg: "Application closed, cleanup performed successfully" });
  } catch (error) {
    console.error("Error during application closure cleanup:", error);
    res.status(500).json({ msg: "Error during cleanup", error: error.message });
  }
});

function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (token == null) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET_KEY, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
