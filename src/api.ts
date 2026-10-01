// 前端 API：REST 行动 + SSE 事件流
export interface GameEvent {
  type: string;
  [key: string]: any;
}

export async function newGame(mode: "normal" | "spectator") {
  const r = await fetch("/api/new", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  return r.json();
}

export async function listGames() {
  const r = await fetch("/api/games");
  return r.json();
}

export async function startGame(id: string) {
  await fetch(`/api/${id}/start`, { method: "POST" });
}

export async function postAction(id: string, action: any) {
  const r = await fetch(`/api/${id}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
  return r.json();
}

export async function negotiate(id: string, npcId: string, text: string) {
  const r = await fetch(`/api/${id}/negotiate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ npcId, text }),
  });
  return r.json();
}

export async function decideOffer(id: string, offerId: string, accept: boolean) {
  const r = await fetch(`/api/${id}/offer/${offerId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accept }),
  });
  return r.json();
}

export function subscribe(id: string, onEvent: (e: GameEvent) => void): () => void {
  const es = new EventSource(`/api/stream/${id}`);
  es.addEventListener("message", (ev) => {
    try {
      onEvent(JSON.parse(ev.data));
    } catch {}
  });
  return () => es.close();
}
