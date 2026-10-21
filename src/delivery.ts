export type DeliveryRequest = {
  tenantId: string;
  deliveryAddress: string;
  totalItems: number;
};

export type DeliveryQuote = {
  status: "requires_shop_confirmation";
  feeKes: null;
  trackingReference: null;
  message: string;
  live: false;
};

export interface DeliveryProvider {
  quote(request: DeliveryRequest): Promise<DeliveryQuote>;
}

export class ManualDeliveryProvider implements DeliveryProvider {
  async quote(request: DeliveryRequest): Promise<DeliveryQuote> {
    return {
      status: "requires_shop_confirmation",
      feeKes: null,
      trackingReference: null,
      message: request.tenantId && request.deliveryAddress && request.totalItems > 0
        ? "The shop confirms delivery availability and fee with the customer."
        : "The shop must confirm a valid delivery request.",
      live: false,
    };
  }
}
