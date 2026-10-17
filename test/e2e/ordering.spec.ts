import { test, expect } from "@playwright/test";
import { setup } from "../worker/helpers.ts";

test("mobile browser completes a table round and the same QR opens the next round", async ({
  page,
}) => {
  const e = await setup();
  try {
    await e.command("/open_table 1");
    const origin = String(await e.mf.ready).replace(/\/$/, "");
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.goto(`${origin}/t/${e.tables[0].permanent_qr_token}`);
    await expect(page.getByLabel("Table PIN")).toBeVisible();
    const s = (await e.db
      .prepare("SELECT join_pin FROM table_sessions WHERE id=1")
      .first<any>())!;
    await page.getByLabel("Table PIN").fill(s.join_pin);
    await expect(
      page.getByRole("button", { name: "Add one Lost Cherry", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Add one Lost Cherry", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: /Review.*Order|View.*Order|View.*Cart|Review.*Cart/i,
      })
      .click();
    await page.getByRole("button", { name: /Place Order/ }).click();
    await expect(
      page.getByText("ORD-0001", { exact: false }).first(),
    ).toBeVisible();
    await e.flush();
    const serve = (await e.db
      .prepare("SELECT id FROM callback_actions WHERE action='order.serve'")
      .first<any>())!.id;
    await e.callback(serve, 1001);
    await page.reload();
    await page.getByRole("button", { name: /My Orders/ }).click();
    await expect(
      page.getByText("SERVED", { exact: false }).first(),
    ).toBeVisible();
    await page.getByRole("button", { name: /Request Payment/ }).click();
    await expect(page.getByText(/Payment requested/).first()).toBeVisible();
    const pay = (await e.db
      .prepare(
        "SELECT id FROM callback_actions WHERE action='payment.confirm' LIMIT 1",
      )
      .first<any>())!.id;
    await e.callback(pay);
    await page.reload();
    await expect(
      page.getByText(/Payment confirmed|Paid|Thank you/i).first(),
    ).toBeVisible();
    const status = (await e.db
      .prepare("SELECT status FROM table_sessions WHERE id=1")
      .first<any>())!;
    expect(status.status).toBe("PAID_CLOSED");
    const receipt = (await e.db
      .prepare("SELECT lookup_token FROM receipts")
      .first<any>())!;
    const response = await page.request.get(
      `${origin}/api/public/receipt/${receipt.lookup_token}`,
    );
    expect(response.status()).toBe(200);
    expect((await response.body()).subarray(0, 4).toString()).toBe("%PDF");
    await e.command("/open_table 1");
    await page.reload();
    await expect(page.getByLabel("Table PIN")).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await e.close();
  }
});
