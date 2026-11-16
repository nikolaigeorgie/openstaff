import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface Status {
  connected: boolean;
  member: string | null;
  org: string | null;
  todayMinutes: number;
  paused: boolean;
  server: string;
  version: string;
  error: string | null;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const hm = (minutes: number) => `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;

let current: Status | null = null;
let localError: string | null = null;

function render(s: Status) {
  current = s;
  $("setup").hidden = s.connected;
  $("main").hidden = !s.connected;
  $("org").textContent = s.connected ? (s.org ?? "") : "";
  $("hello").textContent = s.member ? `Hi ${s.member}` : "";
  $("today").textContent = hm(s.todayMinutes);
  $("state").textContent = s.paused ? "Paused. Time is not being counted." : "counted today";
  $("today").parentElement!.classList.toggle("paused", s.paused);
  $("pause").textContent = s.paused ? "Resume tracking" : "Pause for private time";
  $("version").textContent = `Version ${s.version}`;
  const server = $<HTMLInputElement>("server");
  if (!server.value) server.value = s.server;
  const error = localError ?? s.error;
  $("error").hidden = !error;
  $("error").textContent = error ?? "";
}

$("connect").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $<HTMLButtonElement>("connect-btn");
  button.disabled = true;
  button.textContent = "Connecting…";
  localError = null;
  try {
    render(
      await invoke<Status>("connect", {
        code: $<HTMLInputElement>("code").value,
        server: $<HTMLInputElement>("server").value,
      }),
    );
  } catch (e) {
    localError = String(e);
    if (current) render(current);
  } finally {
    button.disabled = false;
    button.textContent = "Connect";
  }
});

$("pause").addEventListener("click", () => {
  if (current) void invoke("set_paused", { paused: !current.paused });
});

$("mine").addEventListener("click", async () => {
  localError = null;
  try {
    await invoke("open_my_page");
  } catch (e) {
    localError = String(e);
  }
  if (current) render(current);
});

void listen<Status>("status", (event) => render(event.payload));
void invoke<Status>("get_status").then(render);
