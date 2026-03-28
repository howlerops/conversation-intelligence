import { CanonicalEvent, TenantMappedEvent } from '../contracts/analysis';
import { TenantPack } from '../contracts/tenant-pack';

export function mapTenantEvents(
  events: CanonicalEvent[],
  pack: TenantPack,
): TenantMappedEvent[] {
  return events.map((event) => ({
    canonicalType: event.type,
    tenantLabel: pack.taxonomy.canonicalToTenant[event.type] ?? event.type,
    severity: pack.taxonomy.defaultSeverity[event.type] ?? event.businessImpact,
  }));
}
