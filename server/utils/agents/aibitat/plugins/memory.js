const { v4 } = require("uuid");
const {
  getVectorDbClass,
  resolveProviderConnector,
} = require("../../../helpers");
const { Deduplicator } = require("../utils/dedupe");
const { User } = require("../../../../models/user");
const {
  listConnectedFolders,
  formatConnectedFolders,
  searchConnectedDriveWorkspaces,
} = require("../../../chats/googleDriveContext");

const memory = {
  name: "rag-memory",
  startupConfig: {
    params: {},
  },
  plugin: function () {
    return {
      name: this.name,
      setup(aibitat) {
        aibitat.function({
          super: aibitat,
          tracker: new Deduplicator(),
          name: this.name,
          description:
            "Search documents and Google Drive sources the current user is allowed to access, list that user's connected Drive folders, or store long-term memory. Always search when a question asks about contracts, agreements, files, or other company documents; do not ask the user which folder to check when authorized Drive sources are connected. Use list_drive_folders for questions about connected folders. Use store only when explicitly asked to remember or save something.",
          examples: [
            {
              prompt: "Check my files for information about the project",
              call: JSON.stringify({
                action: "search",
                content: "<project information to search for>",
              }),
            },
            {
              prompt: "List the Google Drive folders I can access",
              call: JSON.stringify({ action: "list_drive_folders" }),
            },
            {
              prompt: "What do you know about Plato's motives?",
              call: JSON.stringify({
                action: "search",
                content: "What are the facts about Plato's motives?",
              }),
            },
            {
              prompt: "Remember that you are a robot",
              call: JSON.stringify({
                action: "store",
                content: "I am a robot, the user told me that i am.",
              }),
            },
          ],
          parameters: {
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["search", "store", "list_drive_folders"],
                description:
                  "Search allowed document sources, list connected Google Drive folders, or store a memory when explicitly requested.",
              },
              content: {
                type: "string",
                description:
                  "The plain text to search our local documents with or to store in our vector database.",
              },
            },
            additionalProperties: false,
          },
          handler: async function ({ action = "", content = "" }) {
            try {
              const { isDuplicate } = this.tracker.isDuplicate(this.name, {
                action,
                content,
              });
              if (isDuplicate)
                return `This was a duplicated call and it's output will be ignored.`;

              let response = "There was nothing to do.";
              if (action === "search") response = await this.search(content);
              if (action === "store") response = await this.store(content);
              if (action === "list_drive_folders")
                response = await this.listDriveFolders();

              this.tracker.trackRun(this.name, { action, content });
              return response;
            } catch (error) {
              console.log(error);
              return `There was an error while calling the function. ${error.message}`;
            }
          },
          search: async function (query = "") {
            try {
              const workspace = this.super.handlerProps.invocation.workspace;
              const invocation = this.super.handlerProps.invocation;
              const user = invocation.user_id
                ? await User.get({ id: Number(invocation.user_id) })
                : null;
              const { connector: LLMConnector } =
                await resolveProviderConnector({
                  workspace,
                  prompt: query,
                });
              const vectorDB = getVectorDbClass();
              const { contextTexts = [], sources = [] } =
                await vectorDB.performSimilaritySearch({
                  namespace: workspace.slug,
                  input: query,
                  LLMConnector,
                  similarityThreshold: workspace?.similarityThreshold ?? 0.25,
                  topN: workspace?.topN ?? 4,
                  rerank: workspace?.vectorSearchMode === "rerank",
                });

              const driveSearch = await searchConnectedDriveWorkspaces({
                user,
                currentWorkspace: workspace,
                prompt: query,
                LLMConnector,
                VectorDb: vectorDB,
              });
              const allContextTexts = [
                ...contextTexts,
                ...driveSearch.contextTexts,
              ];
              const allSources = [...sources, ...driveSearch.sources];

              if (allContextTexts.length === 0) {
                this.super.introspect(
                  `${this.caller}: No relevant content was found in the user's accessible documents.`
                );
                return "No relevant content was found in the documents and Google Drive sources available to this user. Do not claim to have scanned folders that are not connected or indexed, and do not ask the user to choose a folder unless a real missing detail prevents the search.";
              }

              this.super.introspect(
                `${this.caller}: Found ${allContextTexts.length} document excerpts to help answer this question.`
              );

              this.super.addCitation?.(allSources);

              let combinedText = "Additional context for query:\n";
              for (const text of allContextTexts) combinedText += text + "\n\n";
              return combinedText;
            } catch (error) {
              this.super.handlerProps.log(
                `memory.search raised an error. ${error.message}`
              );
              return `An error was raised while searching the vector database. ${error.message}`;
            }
          },
          listDriveFolders: async function () {
            try {
              const invocation = this.super.handlerProps.invocation;
              const user = invocation.user_id
                ? await User.get({ id: Number(invocation.user_id) })
                : null;
              return formatConnectedFolders(await listConnectedFolders(user));
            } catch (error) {
              this.super.handlerProps.log(
                `memory.listDriveFolders raised an error. ${error.message}`
              );
              return "Não consegui carregar a lista de pastas conectadas do Google Drive agora.";
            }
          },
          store: async function (content = "") {
            try {
              const workspace = this.super.handlerProps.invocation.workspace;
              const vectorDB = getVectorDbClass();
              const { error } = await vectorDB.addDocumentToNamespace(
                workspace.slug,
                {
                  docId: v4(),
                  id: v4(),
                  url: "file://embed-via-agent.txt",
                  title: "agent-memory.txt",
                  docAuthor: "@agent",
                  description: "Unknown",
                  docSource: "a text file stored by the workspace agent.",
                  chunkSource: "",
                  published: new Date().toLocaleString(),
                  wordCount: content.split(" ").length,
                  pageContent: content,
                  token_count_estimate: 0,
                },
                null
              );

              if (!!error)
                return "The content was failed to be embedded properly.";
              this.super.introspect(
                `${this.caller}: I saved the content to long-term memory in this workspaces vector database.`
              );
              return "The content given was successfully embedded. There is nothing else to do.";
            } catch (error) {
              this.super.handlerProps.log(
                `memory.store raised an error. ${error.message}`
              );
              return `Let the user know this action was not successful. An error was raised while storing data in the vector database. ${error.message}`;
            }
          },
        });
      },
    };
  },
};

module.exports = {
  memory,
};
