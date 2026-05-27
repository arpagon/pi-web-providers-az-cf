#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const extension = process.argv[2] ? resolve(process.argv[2]) : resolve("dist/index.js");
const tool = process.env.PI_WEB_PROVIDERS_E2E_TOOL ?? "web_contents";
const defaultPrompts = {
  web_contents:
    'Use web_contents exactly once for URL "https://example.com". Then answer with exactly one sentence saying whether content was extracted.',
  web_search:
    'Use web_search exactly once for query "OpenAI Responses API web_search_preview docs" with maxResults 1. Then answer with only the first result title and URL.',
  web_answer:
    'Use web_answer exactly once to answer this question: "What is the official name of the example.com domain page?" Then answer with one short sentence.',
  web_research:
    'Use web_research exactly once to research this question: "What is example.com used for?" Then answer with one short sentence saying the research was started.',
};
const prompt = process.env.PI_WEB_PROVIDERS_E2E_PROMPT ?? defaultPrompts[tool] ?? defaultPrompts.web_contents;

const root = `${tmpdir()}/pi-web-providers-az-cf-e2e-${Date.now()}`;
const out = `${root}/pi.jsonl`;
const err = `${root}/pi.err`;
const sessionName = `pi-web-providers-az-cf-e2e-${process.pid}`;

await mkdir(root, { recursive: true });

const command = [
  "cd",
  JSON.stringify(process.cwd()),
  "&&",
  "pi",
  "--no-session",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-builtin-tools",
  "--tools",
  JSON.stringify(tool),
  "--mode",
  "json",
  "-e",
  JSON.stringify(extension),
  "-p",
  JSON.stringify(prompt),
  ">",
  JSON.stringify(out),
  "2>",
  JSON.stringify(err),
].join(" ");

await run("tmux", ["kill-session", "-t", sessionName], { allowFailure: true });
await run("tmux", ["new-session", "-d", "-s", sessionName, command]);

const deadline = Date.now() + Number(process.env.PI_WEB_PROVIDERS_E2E_TIMEOUT_MS ?? 180_000);
while (Date.now() < deadline) {
  const alive = await run("tmux", ["has-session", "-t", sessionName], { allowFailure: true });
  if (alive.code !== 0) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
await run("tmux", ["kill-session", "-t", sessionName], { allowFailure: true });

const stderr = await safeRead(err);
const stdout = await safeRead(out);
const events = stdout
  .split(/\n+/)
  .filter(Boolean)
  .flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });

const toolStarts = events.filter((event) => event.type === "tool_execution_start");
const toolEnds = events.filter((event) => event.type === "tool_execution_end");
const errors = events.filter((event) => event.type === "error");

const summary = {
  extension,
  tool,
  prompt,
  root,
  toolStarts: toolStarts.map((event) => event.toolName),
  toolEnds: toolEnds.map((event) => ({ toolName: event.toolName, isError: event.isError })),
  errors,
  stderr: stderr.trim().split("\n").slice(-20),
};

await writeFile(`${root}/summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));

if (!toolStarts.some((event) => event.toolName === tool)) {
  console.error(`Expected Pi to call ${tool}; see ${root}`);
  process.exit(1);
}
if (toolEnds.some((event) => event.toolName === tool && event.isError)) {
  console.error(`${tool} ended with an error; see ${root}`);
  process.exit(1);
}

if (process.env.PI_WEB_PROVIDERS_E2E_KEEP !== "1") {
  await rm(root, { recursive: true, force: true });
}

async function safeRead(path) {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

async function run(cmd, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { code: code ?? 0, stdout, stderr };
      if (result.code !== 0 && !options.allowFailure) {
        reject(new Error(`${cmd} ${args.join(" ")} failed (${result.code}): ${stderr}`));
      } else {
        resolve(result);
      }
    });
  });
}
