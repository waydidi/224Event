import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/db/database.ts';
import { tableProvisionSql } from '../scripts/provision-print-tables.mjs';

test('seven-table provisioning preserves existing permanent QR tokens and active sessions',()=>{
  const db=new Database(':memory:');try {
    db.migrate();db.raw.exec(tableProvisionSql());
    const before=db.all('SELECT * FROM tables ORDER BY display_number');assert.equal(before.length,7);assert.equal(new Set(before.map(t=>t.permanent_qr_token)).size,7);
    db.run("INSERT INTO table_sessions(table_id,round_number,session_code,status,join_pin,opened_at) VALUES (1,1,'TABLE1-1','OPEN','12',?)",[new Date().toISOString()]);
    db.run("UPDATE tables SET current_session_id=1,status='OCCUPIED' WHERE id=1");
    db.raw.exec(tableProvisionSql());
    const after=db.all('SELECT * FROM tables ORDER BY display_number');assert.deepEqual(after.map(t=>t.permanent_qr_token),before.map(t=>t.permanent_qr_token));assert.equal(after[0].current_session_id,1);assert.equal(after[0].status,'OCCUPIED');
  }finally{db.close();}
});
