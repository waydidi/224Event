import { test } from "node:test";
import assert from "node:assert/strict";
import {
  matchingGroups,
  requireUniqueGroup,
  verifyBotIdentity,
} from "../scripts/setup-telegram.mjs";
test("Telegram setup verifies exact bot and unique staff group before changing settings or messaging", () => {
  verifyBotIdentity({ username: "eventbotbirthday_bot" });
  assert.throws(
    () => verifyBotIdentity({ username: "another_bot" }),
    /different bot/,
  );
  const matches = matchingGroups([
    { message: { chat: { id: -1, title: "224 Event", type: "supergroup" } } },
    {
      my_chat_member: {
        chat: { id: -1, title: "224 Event", type: "supergroup" },
      },
    },
    { message: { chat: { id: -2, title: "Other group", type: "supergroup" } } },
    { message: { chat: { id: 100, title: "224 Event", type: "private" } } },
  ]);
  assert.deepEqual(matches, [{ id: "-1", title: "224 Event" }]);
  assert.equal(requireUniqueGroup(matches).id, "-1");
  assert.throws(() => requireUniqueGroup([]), /No 224 Event/);
  assert.throws(
    () => requireUniqueGroup([{ id: "-1" }, { id: "-2" }]),
    /More than one/,
  );
  assert.deepEqual(
    matchingGroups([
      {
        message: {
          chat: { id: -1, title: "224 Event", type: "group" },
          migrate_to_chat_id: -100123,
        },
      },
    ]),
    [{ id: "-100123", title: "224 Event" }],
  );
});

 test("group title matching tolerates formatting spaces without matching a different group",()=>{
 assert.equal(matchingGroups([{message:{chat:{id:-1,title:" 224\u00a0Event ",type:"group"}}}]).length,1);
 assert.equal(matchingGroups([{message:{chat:{id:-1,title:"224 Event Other",type:"group"}}}]).length,0);
 });
