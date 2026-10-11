// Response shapes. They document the API (OpenAPI components) and are enforced when responses are serialised.
import { z } from 'zod';
import { CATEGORIES, CRITERIA } from './domain.js';

const criterionKey = z.enum(CRITERIA.map((c) => c.key) as ['vibe', 'offer', 'service', 'value']);
const isoDate = z.string().meta({ format: 'date-time' });
const score = z.number().int().min(1).max(5);

export const ErrorBody = z
  .object({ error: z.object({ code: z.string(), message: z.string() }).loose() })
  .meta({ id: 'Error' });

export const StarsQuota = z
  .object({
    perMonth: z.number().int(),
    left: z.number().int(),
    month: z.string().meta({ description: 'First day of the current month, YYYY-MM-DD' }),
  })
  .meta({ id: 'StarsQuota' });

export const Profile = z
  .object({
    id: z.uuid(),
    email: z.string(),
    name: z.string(),
    avatarUrl: z.string().nullable(),
    joinedAt: isoDate,
    stars: StarsQuota,
  })
  .meta({ id: 'Profile' });

export const Session = z
  .object({ token: z.string(), expiresAt: isoDate, user: Profile })
  .meta({ id: 'Session', description: 'Send the token as `Authorization: Bearer <token>`.' });

const Person = z.object({ id: z.uuid(), name: z.string() });

export const PlaceSummary = z
  .object({
    id: z.uuid(),
    name: z.string(),
    category: z.enum(CATEGORIES),
    priceLevel: z.number().int().min(1).max(4).nullable(),
    address: z.string().nullable(),
    location: z.object({ lat: z.number(), lng: z.number() }),
    tags: z.array(z.string()),
    openNow: z.boolean().nullable().meta({ description: 'null when opening hours are unknown' }),
    rating: z.object({ average: z.number().nullable(), count: z.number().int() }),
    stars: z.object({ total: z.number().int(), thisMonth: z.number().int() }),
    coverPhotoUrl: z.string().nullable(),
    distanceKm: z.number().nullable().meta({ description: 'Only when lat/lng were given' }),
    addedBy: Person,
    saved: z.boolean(),
    createdAt: isoDate,
  })
  .meta({ id: 'PlaceSummary' });

export const PlaceList = z.object({ total: z.number().int(), items: z.array(PlaceSummary) }).meta({ id: 'PlaceList' });

export const OpeningPeriod = z
  .object({
    day: z.number().int().min(0).max(6).meta({ description: '0 = Sunday … 6 = Saturday' }),
    open: z.string().meta({ example: '18:00' }),
    close: z.string().meta({ example: '02:00', description: 'Earlier than open = closes after midnight' }),
  })
  .meta({ id: 'OpeningPeriod' });

export const Photo = z.object({ id: z.uuid(), url: z.string() }).meta({ id: 'Photo' });

export const Scores = z.object({ vibe: score, offer: score, service: score.nullable(), value: score.nullable() }).meta({
  id: 'Scores',
  description: 'vibe = klimat, offer = oferta, service = obsługa, value = wartość; null = nie dotyczy',
});

export const PlaceDetail = PlaceSummary.extend({
  description: z.string().nullable(),
  googlePlaceId: z.string().nullable(),
  openingHours: z.array(OpeningPeriod).nullable(),
  photos: z.array(Photo),
  criteria: z.array(z.object({ key: criterionKey, average: z.number().nullable(), count: z.number().int() })),
  strongestCriterion: criterionKey.nullable(),
  commentsCount: z.number().int(),
  myRating: z.object({ scores: Scores, overall: z.number(), updatedAt: isoDate }).nullable(),
  myStar: z.object({ givenThisMonth: z.boolean(), left: z.number().int() }),
  updatedAt: isoDate,
}).meta({ id: 'PlaceDetail' });

export const MyRatingList = z
  .object({
    total: z.number().int(),
    items: z.array(
      z.object({
        place: z.object({ id: z.uuid(), name: z.string(), category: z.enum(CATEGORIES) }),
        scores: Scores,
        overall: z.number(),
        updatedAt: isoDate,
      }),
    ),
  })
  .meta({ id: 'MyRatingList' });

export const StarResult = z.object({ starred: z.boolean(), left: z.number().int() }).meta({ id: 'StarResult' });
export const SavedResult = z.object({ saved: z.boolean() }).meta({ id: 'SavedResult' });

export const Comment = z
  .object({
    id: z.uuid(),
    body: z.string(),
    createdAt: isoDate,
    author: Person.extend({ avatarUrl: z.string().nullable() }),
    authorRating: z.number().nullable().meta({ description: "The author's current overall rating of the place" }),
  })
  .meta({ id: 'Comment' });

export const CommentList = z.object({ total: z.number().int(), items: z.array(Comment) }).meta({ id: 'CommentList' });

export const NetworkStats = z
  .object({
    places: z.number().int(),
    people: z.number().int(),
    ratings: z.number().int(),
    averageRating: z.number().nullable(),
    month: z.string(),
    starsThisMonth: z.number().int(),
    starOfTheMonth: z.object({ place: PlaceSummary, stars: z.number().int() }).nullable(),
    top: z.array(PlaceSummary),
    categories: z.array(
      z.object({
        category: z.enum(CATEGORIES),
        count: z.number().int(),
        share: z.number().meta({ description: '0–1' }),
      }),
    ),
  })
  .meta({ id: 'NetworkStats' });

export const MyStats = z
  .object({
    placesAdded: z.number().int(),
    ratings: z.number().int(),
    averageGiven: z.number().nullable(),
    comments: z.number().int(),
    saved: z.number().int(),
    stars: z.object({ givenTotal: z.number().int(), givenThisMonth: z.number().int(), left: z.number().int() }),
  })
  .meta({ id: 'MyStats' });

export const Meta = z
  .object({
    categories: z.array(z.enum(CATEGORIES)),
    criteria: z.array(z.object({ key: criterionKey, label: z.string(), required: z.boolean() })),
    starsPerMonth: z.number().int(),
    timeZone: z.string(),
  })
  .meta({ id: 'Meta' });
