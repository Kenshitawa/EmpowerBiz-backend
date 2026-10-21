export type PaymentMethod = "cash_on_delivery" | "mpesa_demo";

export type PaymentRequest = {
  orderNumber: string;
  amountKes: number;
  customerPhone: string;
};

export type PaymentAttemptResult = {
  status: "pending" | "failed";
  method: PaymentMethod;
  providerReference: string | null;
  customerMessage: string;
  live: false;
};

export interface PaymentProvider {
  readonly method: PaymentMethod;
  start(request: PaymentRequest): Promise<PaymentAttemptResult>;
}

export class CashOnDeliveryProvider implements PaymentProvider {
  readonly method = "cash_on_delivery" as const;

  async start(request: PaymentRequest): Promise<PaymentAttemptResult> {
    return {
      status: request.orderNumber && request.amountKes > 0 ? "pending" : "failed",
      method: this.method,
      providerReference: null,
      customerMessage: request.orderNumber && request.amountKes > 0
        ? "Payment is due when the shop delivers the order."
        : "A valid order and amount are required.",
      live: false,
    };
  }
}

export class MpesaPreviewProvider implements PaymentProvider {
  readonly method = "mpesa_demo" as const;

  async start(request: PaymentRequest): Promise<PaymentAttemptResult> {
    return {
      status: request.orderNumber && request.amountKes > 0 ? "pending" : "failed",
      method: this.method,
      providerReference: null,
      customerMessage: request.orderNumber && request.amountKes > 0
        ? "M-Pesa is not connected. No payment request was sent."
        : "A valid order and amount are required.",
      live: false,
    };
  }
}

export function getPaymentProvider(method: PaymentMethod): PaymentProvider {
  return method === "cash_on_delivery"
    ? new CashOnDeliveryProvider()
    : new MpesaPreviewProvider();
}
