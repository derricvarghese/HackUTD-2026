import { useEffect, useState } from 'react';
import { reverseGeocode } from '../lib/geocode';

export function useReverseGeocode(lat?: number | null, lng?: number | null): string | null {
  const [address, setAddress] = useState<string | null>(null);

  useEffect(() => {
    if (lat === undefined || lat === null || lng === undefined || lng === null) {
      setAddress(null);
      return;
    }
    let active = true;
    const ctrl = new AbortController();

    reverseGeocode(lat, lng, ctrl.signal)
      .then((addr) => {
        if (active && addr) setAddress(addr);
      })
      .catch(() => {});

    return () => {
      active = false;
      ctrl.abort();
    };
  }, [lat, lng]);

  return address;
}
