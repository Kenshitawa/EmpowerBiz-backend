import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CashOnDeliveryProvider, MpesaPreviewProvider } from "./payments.js";
import { ManualDeliveryProvider } from "./delivery.js";

describe("local provider boundaries", () => {
  it("keeps COD pending until the merchant collects it", async () => {
    const result = await new CashOnDeliveryProvider().start({ orderNumber: "EB-LOCAL", amountKes: 500, customerPhone: "+254700123456" });
    assert.equal(result.status, "pending");
    assert.equal(result.live, false);
  });

  it("never claims that the M-Pesa preview requested or received money", async () => {
    const result = await new MpesaPreviewProvider().start({ orderNumber: "EB-LOCAL", amountKes: 500, customerPhone: "+254700123456" });
    assert.equal(result.status, "pending");
    assert.equal(result.live, false);
    assert.match(result.customerMessage, /No payment request was sent/);
  });

  it("leaves delivery cost and tracking for the shop to confirm", async () => {
    const result = await new ManualDeliveryProvider().quote({ tenantId: "tenant_maua", deliveryAddress: "Nairobi", totalItems: 1 });
    assert.equal(result.status, "requires_shop_confirmation");
    assert.equal(result.feeKes, null);
    assert.equal(result.trackingReference, null);
    assert.equal(result.live, false);
  });
});
