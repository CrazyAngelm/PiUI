//! Cheap lexical similarity for board dedup (ADR-041): lowercased word
//! tokens and character trigrams, each compared with Jaccard, averaged. No
//! model, no service; deterministic and fast enough for 2000 cards.

use super::model::Card;
use std::collections::BTreeSet;

/// Open cards at or above this score are possible duplicates.
pub(crate) const DUPLICATE_THRESHOLD: f64 = 0.45;
/// Most similar cards returned by `context` and dedup.
pub(crate) const MAX_SIMILAR: usize = 5;

fn words(text: &str) -> BTreeSet<String> {
    text.split(|character: char| !character.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_lowercase)
        .collect()
}

fn trigrams(text: &str) -> BTreeSet<String> {
    let normalized: Vec<char> = text
        .to_lowercase()
        .split(|character: char| !character.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .collect();
    if normalized.is_empty() {
        return BTreeSet::new();
    }
    if normalized.len() < 3 {
        return BTreeSet::from([normalized.iter().collect::<String>()]);
    }
    normalized
        .windows(3)
        .map(|window| window.iter().collect())
        .collect()
}

fn jaccard(left: &BTreeSet<String>, right: &BTreeSet<String>) -> f64 {
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let shared = left.intersection(right).count();
    let union = left.union(right).count();
    if union == 0 {
        0.0
    } else {
        shared as f64 / union as f64
    }
}

/// Similarity of a query (title plus labels) to a card's title and labels,
/// in `0.0..=1.0`.
pub(crate) fn score(query: &str, query_labels: &[String], card: &Card) -> f64 {
    let mut query_words = words(query);
    query_words.extend(query_labels.iter().map(|label| label.to_lowercase()));
    let mut card_words = words(&card.title);
    card_words.extend(card.labels.iter().map(|label| label.to_lowercase()));
    let word_score = jaccard(&query_words, &card_words);
    let trigram_score = jaccard(&trigrams(query), &trigrams(&card.title));
    (word_score + trigram_score) / 2.0
}

/// Open cards whose score reaches `threshold`, best first, at most `limit`.
/// Ties keep the higher card number (the newer card) first.
pub(crate) fn similar_open_cards<'a>(
    cards: &'a [Card],
    query: &str,
    labels: &[String],
    threshold: f64,
    limit: usize,
) -> Vec<&'a Card> {
    let mut scored: Vec<(f64, &Card)> = cards
        .iter()
        .filter(|card| !card.status.is_closed())
        .map(|card| (score(query, labels, card), card))
        .filter(|(value, _)| *value >= threshold)
        .collect();
    scored.sort_by(|(left, left_card), (right, right_card)| {
        right
            .partial_cmp(left)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(right_card.number.cmp(&left_card.number))
    });
    scored
        .into_iter()
        .take(limit)
        .map(|(_, card)| card)
        .collect()
}

/// Search over titles, descriptions and labels: every query word must occur
/// in the card (substring, case-insensitive). Best title scores first.
pub(crate) fn search<'a>(
    cards: &'a [Card],
    query: &str,
    include_closed: bool,
    limit: usize,
) -> Vec<&'a Card> {
    let query_words = words(query);
    if query_words.is_empty() {
        return Vec::new();
    }
    let mut matches: Vec<(f64, &Card)> = cards
        .iter()
        .filter(|card| include_closed || !card.status.is_closed())
        .filter(|card| {
            let haystack = format!(
                "{} {} {}",
                card.title.to_lowercase(),
                card.description.to_lowercase(),
                card.labels.join(" ").to_lowercase()
            );
            query_words
                .iter()
                .all(|word| haystack.contains(word.as_str()))
        })
        .map(|card| (score(query, &[], card), card))
        .collect();
    matches.sort_by(|(left, left_card), (right, right_card)| {
        right
            .partial_cmp(left)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(right_card.number.cmp(&left_card.number))
    });
    matches
        .into_iter()
        .take(limit)
        .map(|(_, card)| card)
        .collect()
}
