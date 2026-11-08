/** Recorded-style fixtures injected by AGENT_DEMO_WEATHER=flash_flood (DEMO_MODE only). Every result built from them is labelled `synthetic: true`. */
export const DEMO_FLASH_FLOOD_ALERT = {
  event: 'Flash Flood Warning',
  severity: 'Severe',
  urgency: 'Immediate',
  certainty: 'Observed',
  headline: 'Flash Flood Warning issued for the area until the flood waters recede',
  expires_in_hours: 3,
};

export const DEMO_RISING_GAUGE = {
  site_no: 'DEMO-0001',
  name: 'Demo Creek near the incident (synthetic)',
  gage_height_ft: 9.8,
  discharge_cfs: 4120,
  trend: 'rising' as const,
  rate_ft_per_h: 0.9,
  flood_category: 'moderate',
  distance_km: 1.4,
};
