package com.peartube.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SearchScopeTest {
    @Test
    fun searchScopeHasExpectedSixTabs() {
        assertEquals(
            listOf("Top", "Music", "Library", "Creators", "Sources", "Relays"),
            SearchScope.entries.map { it.label },
        )
    }

    @Test
    fun detectsLinksAndChannelKeys() {
        assertTrue(isSearchLink("peartube://channel/abc"))
        assertTrue(isSearchLink("https://youtu.be/dQw4w9WgXcQ"))
        assertTrue(isSearchLink("http://example.com/file.mp4"))
        assertTrue(isSearchLink("a".repeat(64)))
        assertFalse(isSearchLink("@mkbhd"))
        assertFalse(isSearchLink("Miles Davis"))
        assertFalse(isSearchLink("a".repeat(63)))
    }

    @Test
    fun recentSearchesTrimIgnoreShortAndLinksDedupeAndCapAtSix() {
        var list = emptyList<String>()
        list = addRecentSearchTerm(list, "a")
        list = addRecentSearchTerm(list, "   ")
        list = addRecentSearchTerm(list, "https://youtube.com/watch?v=123")
        list = addRecentSearchTerm(list, "peartube://channel/xyz")
        list = addRecentSearchTerm(list, "f".repeat(64))
        assertEquals(emptyList<String>(), list)

        list = addRecentSearchTerm(list, "  Miles Davis  ")
        list = addRecentSearchTerm(list, "Dune")
        list = addRecentSearchTerm(list, "@veritasium")
        list = addRecentSearchTerm(list, "miles davis")
        assertEquals(listOf("miles davis", "@veritasium", "Dune"), list)

        list = addRecentSearchTerm(list, "Radiohead")
        list = addRecentSearchTerm(list, "Inception")
        list = addRecentSearchTerm(list, "Coltrane")
        list = addRecentSearchTerm(list, "Aphex Twin")
        assertEquals(6, list.size)
        assertEquals("Aphex Twin", list.first())
        assertFalse(list.contains("Dune"))

        val removed = removeRecentSearchTerm(list, "RADIOHEAD")
        assertEquals(5, removed.size)
        assertFalse(removed.any { it.equals("Radiohead", ignoreCase = true) })
    }
}
