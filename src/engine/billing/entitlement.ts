/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type EntitlementType = 'DEMO_PREVIEW' | 'PAID_WEBHOOK';

export interface EntitlementRecord {
  finding_id: string;
  order_id: string;
  customer_email?: string;
  unlocked_at: string;
  amount_usd: number;
  entitlement_type: EntitlementType;
  is_verified_payment: boolean;
}

export class BillingEntitlementStore {
  private static instance: BillingEntitlementStore;
  private processedWebhookEvents = new Set<string>();
  private entitlements = new Map<string, EntitlementRecord>();

  /**
   * Status of live payment provider integration.
   * Standalone MVP operates in ADAPTER_READY mode (no live credit card charges processed).
   */
  public readonly gatewayStatus = 'ADAPTER_READY' as const;

  private constructor() {
    // Check localStorage for persisted test/preview entitlements
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        const stored = window.localStorage.getItem('aidiscost_entitlements');
        if (stored) {
          const list: EntitlementRecord[] = JSON.parse(stored);
          for (const item of list) {
            this.entitlements.set(item.finding_id, item);
          }
        }
      } catch {
        // ignore storage errors
      }
    }
  }

  static getInstance(): BillingEntitlementStore {
    if (!BillingEntitlementStore.instance) {
      BillingEntitlementStore.instance = new BillingEntitlementStore();
    }
    return BillingEntitlementStore.instance;
  }

  /**
   * Returns whether a finding fix package is unlocked (in either preview or paid mode).
   */
  isUnlocked(findingId: string): boolean {
    return this.entitlements.has(findingId);
  }

  /**
   * Returns whether the entitlement represents a genuine verified paid transaction.
   */
  isPaidEntitlement(findingId: string): boolean {
    const record = this.entitlements.get(findingId);
    return Boolean(record && record.is_verified_payment === true);
  }

  getEntitlement(findingId: string): EntitlementRecord | undefined {
    return this.entitlements.get(findingId);
  }

  /**
   * Deterministic webhook processor for verified external payment events
   */
  processWebhookEvent(
    eventId: string,
    findingId: string,
    orderId: string,
    customerEmail?: string
  ): { status: 'SUCCESS' | 'IDEMPOTENT_DUPLICATE'; entitlement: EntitlementRecord } {
    if (this.processedWebhookEvents.has(eventId)) {
      const existing = this.entitlements.get(findingId)!;
      return { status: 'IDEMPOTENT_DUPLICATE', entitlement: existing };
    }

    this.processedWebhookEvents.add(eventId);

    const record: EntitlementRecord = {
      finding_id: findingId,
      order_id: orderId,
      customer_email: customerEmail || 'customer@example.com',
      unlocked_at: new Date().toISOString(),
      amount_usd: 49.00,
      entitlement_type: 'PAID_WEBHOOK',
      is_verified_payment: true,
    };

    this.entitlements.set(findingId, record);

    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        const list = Array.from(this.entitlements.values());
        window.localStorage.setItem('aidiscost_entitlements', JSON.stringify(list));
      } catch {
        // ignore
      }
    }

    return { status: 'SUCCESS', entitlement: record };
  }

  /**
   * Unlocks fix package in preview/adapter mode.
   * Truth-boundary: Explicitly records as DEMO_PREVIEW (is_verified_payment: false).
   */
  unlockFixPackage(findingId: string): EntitlementRecord {
    const orderId = `preview_${findingId}_${Date.now()}`;
    const record: EntitlementRecord = {
      finding_id: findingId,
      order_id: orderId,
      customer_email: undefined,
      unlocked_at: new Date().toISOString(),
      amount_usd: 49.00,
      entitlement_type: 'DEMO_PREVIEW',
      is_verified_payment: false,
    };

    this.entitlements.set(findingId, record);

    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        const list = Array.from(this.entitlements.values());
        window.localStorage.setItem('aidiscost_entitlements', JSON.stringify(list));
      } catch {
        // ignore
      }
    }

    return record;
  }
}
