import { createServer, type Server, type Socket } from "node:net";

/**
 * Throwaway SMTP server for tests.
 *
 * Real enough for nodemailer to talk to (EHLO / AUTH / MAIL / RCPT / DATA), and
 * scriptable per recipient, so failure classification and the retry ladder are
 * exercised against actual SMTP replies rather than a mock.
 */
export type ReceivedMessage = { from: string; to: string[]; data: string };

export type FakeSmtp = {
  port: number;
  messages: ReceivedMessage[];
  /** Reply with this code for RCPT TO of a given address, e.g. 550 or 451. */
  rejectRecipients: Map<string, number>;
  /** Fail AUTH, to simulate a misconfigured account. */
  rejectAuth: boolean;
  close: () => Promise<void>;
};

export async function startFakeSmtp(): Promise<FakeSmtp> {
  const messages: ReceivedMessage[] = [];
  const rejectRecipients = new Map<string, number>();
  const state = { rejectAuth: false };

  const server: Server = createServer((socket: Socket) => {
    let buffer = "";
    let inData = false;
    let current: ReceivedMessage = { from: "", to: [], data: "" };

    const send = (line: string) => socket.write(`${line}\r\n`);
    send("220 test.local ESMTP ready");

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");

      for (;;) {
        if (inData) {
          const terminator = buffer.indexOf("\r\n.\r\n");
          if (terminator === -1) return;
          current.data += buffer.slice(0, terminator);
          buffer = buffer.slice(terminator + 5);
          inData = false;
          messages.push(current);
          current = { from: "", to: [], data: "" };
          send("250 2.0.0 Ok: queued");
          continue;
        }

        const lineEnd = buffer.indexOf("\r\n");
        if (lineEnd === -1) return;
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 2);
        const upper = line.toUpperCase();

        if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
          // No STARTTLS advertised: these tests run unencrypted on localhost.
          send("250-test.local");
          send("250-AUTH PLAIN LOGIN");
          send("250 SIZE 10485760");
        } else if (upper.startsWith("AUTH")) {
          send(state.rejectAuth ? "535 5.7.8 Authentication credentials invalid" : "235 2.7.0 Accepted");
        } else if (upper.startsWith("MAIL FROM")) {
          current.from = line.slice(line.indexOf(":") + 1).trim();
          send("250 2.1.0 Ok");
        } else if (upper.startsWith("RCPT TO")) {
          const address = line.slice(line.indexOf(":") + 1).trim().replace(/^<|>$/g, "");
          const rejection = rejectRecipients.get(address.toLowerCase());
          if (rejection) send(`${rejection} 5.1.1 Rejected for test`);
          else {
            current.to.push(address);
            send("250 2.1.5 Ok");
          }
        } else if (upper === "DATA") {
          inData = true;
          send("354 End data with <CR><LF>.<CR><LF>");
        } else if (upper === "QUIT") {
          send("221 2.0.0 Bye");
          socket.end();
          return;
        } else if (upper === "RSET" || upper.startsWith("NOOP")) {
          send("250 2.0.0 Ok");
        } else {
          send("250 2.0.0 Ok");
        }
      }
    });

    socket.on("error", () => undefined);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Could not bind fake SMTP");

  return {
    port: address.port,
    messages,
    rejectRecipients,
    get rejectAuth() {
      return state.rejectAuth;
    },
    set rejectAuth(value: boolean) {
      state.rejectAuth = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  } as FakeSmtp;
}
