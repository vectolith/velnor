export interface TravelPlanResult {
  destination: string;
  days: number;
  highlights: string[];
  bookingLinks: Array<{ label: string; url: string }>;
  localSpots: Array<{ name: string; category: string; address: string; mapUrl: string }>;
}

export async function buildTravelPlan(params: {
  destination: string;
  days?: number;
  interests?: string;
}): Promise<TravelPlanResult> {
  const days = Math.min(Math.max(params.days || 3, 1), 14);
  const dest = params.destination.trim();
  const encodedDest = encodeURIComponent(dest);

  const localSpots: Array<{ name: string; category: string; address: string; mapUrl: string }> = [];

  // Query OpenStreetMap Nominatim for real coordinates & landmarks
  try {
    const nomRes = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodedDest}&format=json&limit=4&addressdetails=1`,
      {
        headers: { "User-Agent": "OlliBot/1.0 (https://olly.bot)" },
        signal: AbortSignal.timeout(4500),
      }
    );
    if (nomRes.ok) {
      const places = await nomRes.json();
      for (const p of places) {
        localSpots.push({
          name: p.name || String(p.display_name).split(",")[0],
          category: p.type || p.class || "Landmark",
          address: p.display_name,
          mapUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
            p.display_name
          )}`,
        });
      }
    }
  } catch {
    // Fallback if offline
  }

  const bookingLinks = [
    {
      label: `✈️ Google Flights to ${dest}`,
      url: `https://www.google.com/travel/flights?q=Flights+to+${encodedDest}`,
    },
    {
      label: `🏨 Hotels in ${dest} (Booking.com)`,
      url: `https://www.booking.com/searchresults.html?ss=${encodedDest}`,
    },
    {
      label: `🗺️ Explore ${dest} on Google Maps`,
      url: `https://www.google.com/maps/search/?api=1&query=${encodedDest}+top+sights+restaurants`,
    },
  ];

  const highlights = [
    `Day 1: Arrival in ${dest}, neighborhood walking tour, sunset viewpoint & local dinner reservation.`,
    days >= 2
      ? `Day 2: Iconic cultural landmarks, specialty coffee spots, and ${
          params.interests || "hidden local gems & street food"
        }.`
      : null,
    days >= 3
      ? `Day 3: Day excursion / scenic district exploration, artisan shopping & farewell tasting menu.`
      : null,
  ].filter(Boolean) as string[];

  return {
    destination: dest,
    days,
    highlights,
    bookingLinks,
    localSpots,
  };
}

