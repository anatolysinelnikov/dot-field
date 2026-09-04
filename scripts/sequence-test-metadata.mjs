export const V3_PHENOMENA_METADATA = Object.freeze({
  available: false,
  provider: 'GIMET-2010',
  dtype: 'Uint8',
  logical_dimensions: ['latitude', 'longitude'],
  codebook: {
    0: 'no radio echo', 1: 'upper/mid-level cloud', 2: 'stratiform cloud',
    3: 'weak precipitation', 4: 'moderate precipitation', 5: 'strong precipitation',
    6: 'convective cloud', 7: 'weak shower', 8: 'moderate shower', 9: 'strong shower',
    10: 'thunderstorm probability 30-70%', 11: 'thunderstorm probability 71-90%',
    12: 'thunderstorm probability >90%', 13: 'weak hail', 14: 'moderate hail',
    15: 'strong hail', 16: 'weak squall', 17: 'moderate squall', 18: 'strong squall',
    19: 'tornado', 31: 'missing / NoData'
  },
  background_codes: [0],
  missing_code: 31,
  support_codes: Array.from({ length: 19 }, (_, index) => index + 1),
  frame_byte_length: 0,
  frame_assets: []
});
