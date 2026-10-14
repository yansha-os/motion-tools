import type { AnimationRecipe } from './recipes.js';

export function animationVisualContext(recipe: AnimationRecipe, time: number) {
  const markerRadiusSeconds = 0.5;
  const contactBoundaryRadiusSeconds = 0.35;
  const nearbyMarkers = recipe.markers.map(marker => ({ ...marker, offsetSeconds: marker.time - time }))
    .filter(marker => Math.abs(marker.offsetSeconds) <= markerRadiusSeconds)
    .sort((left, right) => Math.abs(left.offsetSeconds) - Math.abs(right.offsetSeconds) || left.time - right.time).slice(0, 6)
    .sort((left, right) => left.time - right.time);
  const contacts = recipe.contacts ?? [];
  const activeDeclaredContacts = contacts.filter(contact => contact.start <= time && time <= contact.end);
  const nearbyContactBoundaries = contacts.flatMap(contact => [
    { effector: contact.effector, kind: contact.kind, boundary: 'start' as const, time: contact.start },
    { effector: contact.effector, kind: contact.kind, boundary: 'end' as const, time: contact.end },
  ]).map(boundary => ({ ...boundary, offsetSeconds: boundary.time - time }))
    .filter(boundary => Math.abs(boundary.offsetSeconds) <= contactBoundaryRadiusSeconds)
    .sort((left, right) => Math.abs(left.offsetSeconds) - Math.abs(right.offsetSeconds) || left.time - right.time).slice(0, 6)
    .sort((left, right) => left.time - right.time);
  return { normalizedProgress: time / recipe.duration, nearbyMarkers, activeDeclaredContacts,
    nearbyContactBoundaries, interpretation: 'Markers, phases and contact windows are authored metadata, not proof of visible pose, actual contact, intent, or quality.' };
}
