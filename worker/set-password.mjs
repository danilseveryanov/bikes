#!/usr/bin/env node
/* Задаёт пароль владельца сайта.
 *
 *   cd worker && node set-password.mjs
 *
 * Пароль никуда не отправляется и никуда не записывается: из него считается
 * PBKDF2-хеш со случайной солью, и на сервер уезжает только хеш. Восстановить
 * пароль из него нельзя — забыли, просто задайте новый этой же командой.
 */
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

/* Потолок процессорного времени у Worker'а: 200 000 итераций в него не влезают
   и вход падает с 1101. 100 000 проходят, 60 000 — с запасом на нагрузку.
   Хеш при этом никогда не покидает сервер, а перебор снаружи ограничен
   счётчиком попыток, так что запас прочности здесь не в числе итераций. */
const ITER = 60000;
const b64url = b => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function ask(question) {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // гасим эхо, чтобы пароль не остался в терминале и в истории
    const onData = () => rl.output.write("\x1B[2K\x1B[200D" + question);
    rl.output.write(question);
    rl.input.on("data", onData);
    rl.question("", answer => { rl.input.off("data", onData); rl.output.write("\n"); rl.close(); resolve(answer); });
  });
}

const pw = (await ask("Придумайте пароль: ")).trim();
if (pw.length < 10) {
  console.error("\nСлишком короткий — нужно хотя бы 10 символов. Этот пароль защищает запись в ваш журнал.");
  process.exit(1);
}
const again = (await ask("Повторите пароль: ")).trim();
if (pw !== again) { console.error("\nПароли не совпали."); process.exit(1); }

const salt = randomBytes(16);
const hash = pbkdf2Sync(pw, salt, ITER, 32, "sha256");
const secret = `pbkdf2$${ITER}$${b64url(salt)}$${b64url(hash)}`;

console.log("\nОтправляю хеш в Cloudflare…");
const r = spawnSync("npx", ["wrangler", "secret", "put", "AUTH"], {
  input: secret, encoding: "utf8", stdio: ["pipe", "inherit", "inherit"],
});
process.exit(r.status ?? 1);
