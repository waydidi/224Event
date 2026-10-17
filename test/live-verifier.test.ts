import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

test("live smoke check waits for asset propagation but rejects persistent redirects", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "224-live-verifier-"));
  const script = path.resolve("scripts/verify-live.mjs");
  const mock = path.join(dir, "network.mjs");
  fs.writeFileSync(
    path.join(dir, "deployment.log"),
    "https://224event.verification-test.workers.dev",
  );
  fs.writeFileSync(
    mock,
    `
    let rootRequests=0;
    globalThis.setTimeout=(fn)=>{queueMicrotask(fn);return 0;};
    globalThis.fetch=async(url,options)=>{
      if(new URL(url).hostname==='api.telegram.org'){
        const method=new URL(url).pathname.split('/').at(-1);
        const body=JSON.parse(options.body);
        const user={id:12,is_bot:false};
        const result=method==='getMe'?{id:42,username:'Eventbotbirthday_bot'}
          :method==='getChat'?{title:' 224  Event '}
          :method==='getChatAdministrators'?[{status:'creator',user}]
          :{status:body.user_id===42?'member':'creator',user:body.user_id===42?{id:42,is_bot:true}:user};
        return Response.json({ok:true,result});
      }
      if(options.redirect!=='manual')throw Error('Verifier must not follow redirects');
      const p=new URL(url).pathname;
      if(p==='/healthz')return Response.json({ok:true,runtime:'cloudflare-workers',database:'d1',telegramConfigured:false,telegramGroupFullAccess:true,menuReady:true});
      if(p==='/api/public/menu')return Response.json({categories:[{name:'Cocktails'}]});
      if(p==='/api/internal/tables')return new Response('',{status:401});
      if(p==='/api/integrations/telegram/webhook')return new Response('',{status:503});
      if(p==='/' && (++rootRequests<3 || process.env.TEST_PERSISTENT_REDIRECT==='1'))return new Response('',{status:307,headers:{location:'/'}});
      return new Response('224 Live House');
    };
  `,
  );
  try {
    const run = (persistent: boolean) =>
      spawnSync(
        process.execPath,
        ["--import", pathToFileURL(mock).href, script],
        {
          cwd: dir,
          encoding: "utf8",
          env: {
            ...process.env,
            GITHUB_STEP_SUMMARY: "",
            TEST_PERSISTENT_REDIRECT: persistent ? "1" : "0",
            TELEGRAM_BOT_TOKEN: "test-token",
            TELEGRAM_VERIFY_CHAT_ID: "-123",
          },
        },
      );
    const success = run(false);
    assert.equal(success.status, 0, success.stderr);
    assert.match(success.stdout, /Waiting for \/: HTTP 307/);
    assert.match(success.stdout, /membership lookup verified; bot administrator: false/);
    assert.ok(
      JSON.parse(
        fs.readFileSync(path.join(dir, "live-verification.json"), "utf8"),
      ).health.ok,
    );
    const failure = run(true);
    assert.notEqual(failure.status, 0);
    assert.match(failure.stderr, /307 !== 200/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
