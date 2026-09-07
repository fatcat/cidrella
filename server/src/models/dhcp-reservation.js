import {
  allocateStaticDhcp,
  deallocateStaticDhcp
} from '../services/ip-lifecycle-service.js';
import { syncPtrForIp } from '../utils/ip-sync.js';

function reservationFqdn(hostname, subnet) {
  if (!hostname) return '';
  return subnet?.domain_name ? `${hostname}.${subnet.domain_name}` : hostname;
}

function getReservationWithSubnet(db, reservationId) {
  return db.prepare(`
    SELECT dr.*, sub.cidr as subnet_cidr, sub.name as subnet_name
    FROM dhcp_reservations dr
    JOIN subnets sub ON dr.subnet_id = sub.id
    WHERE dr.id = ?
  `).get(reservationId);
}

export function createReservation(db, subnet, fields) {
  const create = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO dhcp_reservations (subnet_id, mac_address, ip_address, hostname, description)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      subnet.id,
      fields.mac_address,
      fields.ip_address,
      fields.hostname || null,
      fields.description || null
    );

    allocateStaticDhcp(db, subnet.id, fields.ip_address, {
      hostname: fields.hostname || null,
      mac_address: fields.mac_address
    }, result.lastInsertRowid);
    syncPtrForIp(db, subnet.id, fields.ip_address, reservationFqdn(fields.hostname, subnet), {
      source: fields.hostname ? 'reservation' : 'placeholder'
    });

    return result.lastInsertRowid;
  });

  return getReservationWithSubnet(db, create());
}

export function updateReservation(db, reservation, subnet, fields) {
  const update = db.transaction(() => {
    db.prepare(`
      UPDATE dhcp_reservations SET mac_address = ?, ip_address = ?, hostname = ?,
        description = ?, enabled = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      fields.mac_address,
      fields.ip_address,
      fields.hostname !== undefined ? (fields.hostname || null) : reservation.hostname,
      fields.description !== undefined ? (fields.description || null) : reservation.description,
      fields.enabled !== undefined ? (fields.enabled ? 1 : 0) : reservation.enabled,
      reservation.id
    );

    if (fields.ip_address !== reservation.ip_address) {
      deallocateStaticDhcp(db, reservation.subnet_id, reservation.ip_address, reservation.mac_address);
      syncPtrForIp(db, reservation.subnet_id, reservation.ip_address, '', { source: 'placeholder' });
    }

    const newHostname = fields.hostname !== undefined ? (fields.hostname || null) : reservation.hostname;
    const newEnabled = fields.enabled !== undefined ? fields.enabled : reservation.enabled;
    if (newEnabled) {
      allocateStaticDhcp(db, reservation.subnet_id, fields.ip_address, {
        hostname: newHostname,
        mac_address: fields.mac_address
      }, reservation.id);
      syncPtrForIp(db, reservation.subnet_id, fields.ip_address, reservationFqdn(newHostname, subnet), {
        source: newHostname ? 'reservation' : 'placeholder'
      });
    } else {
      deallocateStaticDhcp(db, reservation.subnet_id, fields.ip_address, fields.mac_address);
      syncPtrForIp(db, reservation.subnet_id, fields.ip_address, '', { source: 'placeholder' });
    }
  });

  update();
  return getReservationWithSubnet(db, reservation.id);
}

export function deleteReservation(db, reservation) {
  const del = db.transaction(() => {
    db.prepare('DELETE FROM dhcp_reservations WHERE id = ?').run(reservation.id);
    deallocateStaticDhcp(db, reservation.subnet_id, reservation.ip_address, reservation.mac_address);
    syncPtrForIp(db, reservation.subnet_id, reservation.ip_address, '', { source: 'placeholder' });
  });

  del();
}
