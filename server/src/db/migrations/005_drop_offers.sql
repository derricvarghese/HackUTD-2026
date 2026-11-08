-- Neighbor assist was removed from the product: drop its tables (offer_matches first: it references offers and sos).
DROP TABLE IF EXISTS offer_matches;
DROP TABLE IF EXISTS offers;
