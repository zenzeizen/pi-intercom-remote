/**
 * Renders an inbound pi-relay peer message as a bordered inline component
 * in the pi transcript. Shown for both fire-and-forget messages and asks
 * (asks include a reply hint in the footer).
 */

import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Message, SessionInfo } from "../types.ts";

export interface InlineMessageDetails {
  from: SessionInfo;
  message: Message;
  expectsReply: boolean;
  /** Optional human-readable hint at the bottom of the box for how to reply. */
  replyCommand?: string;
}

export class InlineMessageComponent implements Component {
  constructor(
    private readonly details: InlineMessageDetails,
    private readonly theme: Theme,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const { from, message, expectsReply, replyCommand } = this.details;
    if (width < 3) {
      return [truncateToWidth(`From ${from.name ?? from.id.slice(0, 8)}`, width)];
    }
    const bodyWidth = Math.max(1, width - 2);
    const accent = (text: string) => this.theme.fg("accent", text);
    const dim = (text: string) => this.theme.fg("dim", text);

    const row = (text = ""): string => {
      const clipped = truncateToWidth(text, bodyWidth, "");
      const padding = " ".repeat(Math.max(0, bodyWidth - visibleWidth(clipped)));
      return accent(`│${clipped}${padding}│`);
    };

    const senderName = from.name ?? from.id.slice(0, 8);
    const icon = expectsReply ? "❓" : "📨";
    const header = ` ${icon} ${expectsReply ? "Ask" : "Message"} from: ${senderName} `;
    const headerText = truncateToWidth(header, bodyWidth, "");
    const headerPadding = "─".repeat(Math.max(0, bodyWidth - visibleWidth(headerText)));
    const lines: string[] = [];
    lines.push(accent(`╭${headerText}${headerPadding}╮`));

    for (const line of wrapTextWithAnsi(message.content.text, bodyWidth - 2)) {
      lines.push(row(` ${line}`));
    }

    if (replyCommand) {
      lines.push(row());
      for (const line of wrapTextWithAnsi(dim(` ↩ Reply: ${replyCommand}`), bodyWidth)) {
        lines.push(row(line));
      }
    }

    if (message.content.attachments?.length) {
      lines.push(row());
      for (const att of message.content.attachments) {
        lines.push(row(dim(` 📎 ${att.name}`)));
      }
    }

    if (message.replyTo && !expectsReply) {
      lines.push(row());
      lines.push(row(dim(` ↳ in reply to ${message.replyTo.slice(0, 8)}`)));
    }

    lines.push(accent(`╰${"─".repeat(bodyWidth)}╯`));
    return lines;
  }
}
