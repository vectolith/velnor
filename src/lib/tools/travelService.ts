export interface LiveWeatherSnapshot {
  temperatureC: number;
  temperatureF: number;
  condition: string;
  windKmh: number;
}

export interface TravelPlanResult {
  destination: string;
  days: number;
  weather?: LiveWeatherSnapshot;
  highlights: string[];
  bookingLinks: Array<{ label: string; url: string }>;
  localSpots: Array<{ name: string; category: string; address: string; mapUrl: string }>;
}

function mapWmoWeatherCode(code: number): string {
  if (code === 0) return "☀️ Clear sky";
  if (code <= 3) return "⛅ Partly cloudy";
  if (code <= 49) return "🌫️ Misty / Fog";
  if (code <= 69) return "🌧️ Light to moderate rain";
  if (code <= 79) return "❄️ Snowfall";
  if (code <= 99) return "⛈️ Showers / Thunderstorms";
  return "🌤️ Pleasant";
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
  let lat: number | undefined;
  let lon: number | undefined;

  // 1. Query OpenStreetMap Nominatim for real coordinates & landmarks
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
      if (places[0]?.lat && places[0]?.lon) {
        lat = Number(places[0].lat);
        lon = Number(places[0].lon);
      }
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

  // 2. Query Open-Meteo for live real-time weather at the destination coordinates
  let weather: LiveWeatherSnapshot | undefined;
  if (lat !== undefined && lon !== undefined) {
    try {
      const meteoUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`;
      const meteoRes = await fetch(meteoUrl, { signal: AbortSignal.timeout(4000) });
      if (meteoRes.ok) {
        const meteoData = await meteoRes.json();
        const cw = meteoData.current_weather;
        if (cw && typeof cw.temperature === "number") {
          const tempC = Math.round(cw.temperature * 10) / 10;
          weather = {
            temperatureC: tempC,
            temperatureF: Math.round((tempC * 9) / 5 + 32),
            condition: mapWmoWeatherCode(Number(cw.weathercode || 0)),
            windKmh: Math.round(Number(cw.windspeed || 0)),
          };
        }
      }
    } catch {
      // Ignore weather timeout
    }
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
      ? `Day 2: Iconic cultural landmarks, specialty pour-over coffee spots, and ${
          params.interests || "hidden local gems & street food"
        }.`
      : null,
    days >= 3
      ? `Day 3: Scenic district excursion, artisan markets & farewell tasting menu.`
      : null,
  ].filter(Boolean) as string[];

  return {
    destination: dest,
    days,
    weather,
    highlights,
    bookingLinks,
    localSpots,
  };
}
