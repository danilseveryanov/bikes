#!/usr/bin/env node
/* Задаёт пароль владельца сайта на сервере.
 *
 *   node server/set-password.mjs [root@IP]
 *
 * Пароль никуда не записывается и не показывается: из него считается
 * PBKDF2-хеш со случайной солью, и на сервер по ssh уезжает только хеш.
 * Восстановить пароль из него нельзя — забыли, задайте новый этой же командой.
 * Смена пароля гасит все выданные сессии: токен подписан этим же секретом.
 */
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

/* На своём сервере потолка процессорного времени нет — в отличие от Worker'а,
   где 200 000 итераций валили вход с ошибкой 1101. */
const ITER = 200000;
const TARGET = process.argv[2] || process.env.BIKES_TARGET || "root@109.68.212.36";
const KEY = process.env.SSH_KEY || `${homedir()}/.ssh/dit_vps_rsa`;
const b64url = b => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/* Пароль читается в «сыром» режиме терминала: символы вообще не выводятся.
   Прежний способ — дать readline напечатать символ и тут же стереть строку —
   в терминальной панели Claude не стирал, и пароль оставался на экране. */
function ask(question) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) return reject(new Error("Запустите в терминале: пароль читается с клавиатуры."));
    stdout.write(question);
    stdin.setRawMode(true); stdin.setEncoding("utf8"); stdin.resume();
    let buf = "";
    const done = err => {
      stdin.off("data", onData); stdin.setRawMode(false); stdin.pause(); stdout.write("\n");
      err ? reject(err) : resolve(buf);
    };
    const onData = chunk => {
      if (chunk.startsWith("\x1b")) return;              // стрелки и прочие клавиши
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003") return done(new Error("Отменено."));
        if (ch === "\u007f" || ch === "\b") { buf = [...buf].slice(0, -1).join(""); continue; }
        if (ch >= " ") buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

let pw, again;
try {
  pw = (await ask("Придумайте пароль (на экране не появится): ")).trim();
  if (!pw) { console.error("Пустой пароль пустил бы править любого. Введите хоть что-нибудь."); process.exit(1); }
  again = (await ask("Повторите пароль: ")).trim();
} catch (e) { console.error(e.message); process.exit(1); }
if (again !== pw) { console.error("Пароли не совпали."); process.exit(1); }

const salt = randomBytes(16);
const secret = `pbkdf2$${ITER}$${b64url(salt)}$${b64url(pbkdf2Sync(pw, salt, ITER, 32, "sha256"))}`;

console.log(`\nОтправляю хеш на ${TARGET}…`);
const r = spawnSync("ssh", ["-i", KEY, "-o", "StrictHostKeyChecking=accept-new", TARGET,
  "umask 177 && cat > /etc/bikes.env && systemctl restart bikes && sleep 1 && systemctl is-active bikes"], {
  input: `AUTH=${secret}\n`, encoding: "utf8", stdio: ["pipe", "inherit", "inherit"],
});
if (r.status === 0) console.log("Пароль задан, сервис перезапущен. Старые сессии погашены — войдите заново.");
process.exit(r.status ?? 1);
