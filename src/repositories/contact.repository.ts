import { getDb } from '../db';
import type { ContactRow, ExternalIdentityRow } from '../types/domain';

export interface IdentityInput {
  tenantId: string;
  channel: string;
  externalUserId: string;
  phone?: string | null;
  profileName?: string | null;
}

export interface ResolvedContact {
  contact: ContactRow;
  identity: ExternalIdentityRow;
}

/**
 * Resuelve (o crea) contacto + identidad externa. El teléfono NO es la clave:
 * la clave es (tenant, canal, external_user_id), para que mañana un mismo
 * contacto pueda tener identidades de otros canales.
 */
export function resolveContact(input: IdentityInput): ResolvedContact {
  const db = getDb();

  return db.transaction((): ResolvedContact => {
    const existing = db
      .prepare(
        `SELECT * FROM external_identities
         WHERE tenant_id = ? AND channel = ? AND external_user_id = ?`,
      )
      .get(input.tenantId, input.channel, input.externalUserId) as ExternalIdentityRow | undefined;

    if (existing) {
      // Refrescamos metadatos que el canal puede cambiar entre mensajes.
      if (
        (input.profileName && input.profileName !== existing.profile_name) ||
        (input.phone && input.phone !== existing.phone)
      ) {
        db.prepare(
          `UPDATE external_identities
             SET profile_name = COALESCE(?, profile_name),
                 phone = COALESCE(?, phone),
                 updated_at = datetime('now')
           WHERE id = ?`,
        ).run(input.profileName ?? null, input.phone ?? null, existing.id);
      }
      if (input.profileName) {
        db.prepare(
          `UPDATE contacts
              SET display_name = COALESCE(display_name, ?),
                  primary_phone = COALESCE(primary_phone, ?),
                  updated_at = datetime('now')
            WHERE id = ?`,
        ).run(input.profileName, input.phone ?? null, existing.contact_id);
      }
      const contact = db
        .prepare(`SELECT * FROM contacts WHERE id = ?`)
        .get(existing.contact_id) as ContactRow;
      const identity = db
        .prepare(`SELECT * FROM external_identities WHERE id = ?`)
        .get(existing.id) as ExternalIdentityRow;
      return { contact, identity };
    }

    const contactId = db
      .prepare(
        `INSERT INTO contacts (tenant_id, display_name, primary_phone) VALUES (?, ?, ?)`,
      )
      .run(input.tenantId, input.profileName ?? null, input.phone ?? null)
      .lastInsertRowid as number;

    const identityId = db
      .prepare(
        `INSERT INTO external_identities
           (tenant_id, contact_id, channel, external_user_id, phone, profile_name)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.tenantId,
        contactId,
        input.channel,
        input.externalUserId,
        input.phone ?? null,
        input.profileName ?? null,
      ).lastInsertRowid as number;

    return {
      contact: db.prepare(`SELECT * FROM contacts WHERE id = ?`).get(contactId) as ContactRow,
      identity: db
        .prepare(`SELECT * FROM external_identities WHERE id = ?`)
        .get(identityId) as ExternalIdentityRow,
    };
  })();
}

export function setContactName(contactId: number, name: string): void {
  getDb()
    .prepare(`UPDATE contacts SET display_name = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(name, contactId);
}

export function getContact(tenantId: string, contactId: number): ContactRow | null {
  return (
    (getDb()
      .prepare(`SELECT * FROM contacts WHERE id = ? AND tenant_id = ?`)
      .get(contactId, tenantId) as ContactRow | undefined) ?? null
  );
}
