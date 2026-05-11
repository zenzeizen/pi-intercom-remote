/**
 * /intercom overlay: lists peers in the current room and lets the user pick
 * one to message. Confirming on a peer prompts for message text via the
 * standard ui.input dialog and sends a fire-and-forget peer.send.
 *
 * Intentionally minimal compared to pi-intercom's overlay — no presence
 * sparkline, no compose-with-attachments. v1 keeps it functional; richer
 * UX can come later without changing the protocol.
 */

import type { Component, KeybindingsManager, OverlayHandle } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { RelayClient } from "../relay-client.ts";
import type { SessionInfo } from "../types.ts";

function shortId(id: string): string {
  return id.slice(0, 8);
}

class SessionListOverlay implements Component {
  private selectedIndex = 0;
  private readonly maxVisible = 8;

  constructor(
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly selfId: string | undefined,
    private readonly room: string | undefined,
    private readonly peers: SessionInfo[],
    private readonly done: (selected: SessionInfo | undefined) => void,
  ) {}

  invalidate(): void {}

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.done(undefined);
      return;
    }
    if (this.peers.length === 0) return;
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.selectedIndex = (this.selectedIndex + this.peers.length - 1) % this.peers.length;
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      this.selectedIndex = (this.selectedIndex + 1) % this.peers.length;
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const peer = this.peers[this.selectedIndex];
      if (peer) this.done(peer);
    }
  }

  render(width: number): string[] {
    const innerWidth = Math.max(36, Math.min(width - 2, 88));
    const contentWidth = Math.max(1, innerWidth - 2);
    const border = (text: string) => this.theme.fg("accent", text);
    const dim = (text: string) => this.theme.fg("dim", text);
    const row = (text = ""): string => {
      const clipped = truncateToWidth(text, contentWidth, "", true);
      const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)));
      return `${border("│")}${clipped}${padding}${border("│")}`;
    };

    const footer = `${this.keybindings.getKeys("tui.select.confirm").join("/")}: Send to peer • ${this.keybindings.getKeys("tui.select.cancel").join("/")}: Close`;
    const lines: string[] = [];
    lines.push(border(`╭${"─".repeat(contentWidth)}╮`));
    lines.push(row(this.theme.bold(" pi-relay")));
    lines.push(row(dim(` Room: ${this.room ?? "(not in a room)"}`)));
    lines.push(border(`├${"─".repeat(contentWidth)}┤`));

    if (this.peers.length === 0) {
      lines.push(row(dim(" No peers in this room.")));
      lines.push(row(dim(" Use /intercom join <code> to join one.")));
    } else {
      const startIndex = Math.max(
        0,
        Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.peers.length - this.maxVisible),
      );
      const endIndex = Math.min(startIndex + this.maxVisible, this.peers.length);
      for (let i = startIndex; i < endIndex; i++) {
        const peer = this.peers[i]!;
        const isSelected = i === this.selectedIndex;
        const isSelf = peer.id === this.selfId;
        const tags = [isSelf ? "self" : undefined, peer.status].filter((t): t is string => Boolean(t));
        const tagSuffix = tags.length ? ` [${tags.join(", ")}]` : "";
        const name = peer.name ?? "(unnamed)";
        const title = `${name} (${shortId(peer.id)})${tagSuffix}`;
        const prefix = isSelected ? this.theme.fg("accent", "→ ") : "  ";
        lines.push(row(`${prefix}${isSelected ? this.theme.fg("accent", title) : title}`));
        if (peer.cwd || peer.model) {
          lines.push(row(dim(`    ${[peer.cwd, peer.model].filter(Boolean).join(" • ")}`)));
        }
      }
    }

    lines.push(border(`├${"─".repeat(contentWidth)}┤`));
    lines.push(row(dim(` ${footer}`)));
    lines.push(border(`╰${"─".repeat(contentWidth)}╯`));
    return lines;
  }
}

export async function openSessionListOverlay(
  ctx: ExtensionContext,
  client: RelayClient,
): Promise<void> {
  if (!ctx.hasUI) return;
  const peers = client.listSessions();
  let handle: OverlayHandle | undefined;
  const selectedPeer = await ctx.ui.custom<SessionInfo | undefined>(
    (_tui, theme, keybindings, done) => {
      return new SessionListOverlay(
        theme,
        keybindings,
        client.sessionId,
        client.room,
        peers.filter((p) => p.id !== client.sessionId), // exclude self from selectable list
        (result) => {
          handle?.hide();
          done(result);
        },
      );
    },
    {
      overlay: true,
      onHandle: (h) => {
        handle = h;
      },
    },
  );
  if (!selectedPeer) return;

  const text = await ctx.ui.input(`Message to ${selectedPeer.name ?? shortId(selectedPeer.id)}`, "Type your message…");
  if (!text || !text.trim()) return;
  try {
    await client.send(selectedPeer.id, { text: text.trim() });
    ctx.ui.notify(`pi-relay: sent to ${selectedPeer.name ?? shortId(selectedPeer.id)}`, "info");
  } catch (err) {
    ctx.ui.notify(`pi-relay send failed: ${(err as Error).message}`, "error");
  }
}
