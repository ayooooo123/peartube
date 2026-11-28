package com.peartube.app

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DiscoverApiTest {

    @Test
    fun parsesDiscoverCreatorWithAvatarAndOptionalNulls() {
        val full = DiscoverCreator.from(
            JSONObject()
                .put("id", "youtube:UCSJ4gkVC6NrvII8umztf0Ow")
                .put("source", "YouTube")
                .put("handle", "@LofiGirl")
                .put("name", "Lofi Girl")
                .put("url", "https://www.youtube.com/channel/UCSJ4gkVC6NrvII8umztf0Ow")
                .put("channelId", "UCSJ4gkVC6NrvII8umztf0Ow")
                .put("avatar", "/v1/discover/thumb/0123456789abcdef0123")
                .put("followedAt", 1763500000000L),
        )
        assertEquals("youtube:UCSJ4gkVC6NrvII8umztf0Ow", full.id)
        assertEquals("youtube", full.source)
        assertEquals("@LofiGirl", full.handle)
        assertEquals("Lofi Girl", full.displayName)
        assertEquals("/v1/discover/thumb/0123456789abcdef0123", full.avatar)
        assertEquals(1763500000000L, full.followedAt)
        assertTrue(full.followed)

        val sparse = DiscoverCreator.from(
            JSONObject()
                .put("id", "rumble:c/creatorone")
                .put("source", "rumble")
                .put("handle", "CreatorOne")
                .put("name", JSONObject.NULL)
                .put("avatar", JSONObject.NULL)
                .put("url", "https://rumble.com/c/CreatorOne")
                .put("followedAt", 0),
        )
        assertEquals("rumble:c/creatorone", sparse.id)
        assertEquals("CreatorOne", sparse.displayName)
        assertEquals("", sparse.avatar)
        assertEquals(0L, sparse.followedAt)
        assertFalse(sparse.followed)
    }

    @Test
    fun parsesDiscoverItemForVideoAndAudioAndHandlesNullFields() {
        val sc = DiscoverItem.from(
            JSONObject()
                .put("id", "soundcloud:9001")
                .put("source", "soundcloud")
                .put("kind", "audio")
                .put("itemId", "9001")
                .put("title", "Midnight Tape")
                .put("creatorId", "soundcloud:4242")
                .put("creatorName", "Nova Beats")
                .put("creatorUrl", "https://soundcloud.com/nova-beats")
                .put("url", "https://soundcloud.com/nova-beats/midnight-tape")
                .put("thumbnail", "/v1/discover/thumb/abcdef0123456789abcd")
                .put("duration", 185)
                .put("publishedAt", 1763640000000L)
                .put("acquireId", "sc:112233445566:s01e01")
                .put("audioOnly", true)
                .put("music", JSONObject().put("title", "Midnight Tape").put("artist", "Nova Beats"))
                .put("inLibrary", false),
        )
        assertEquals("soundcloud:9001", sc.id)
        assertEquals("soundcloud", sc.source)
        assertEquals("audio", sc.kind)
        assertEquals("Midnight Tape", sc.title)
        assertEquals("Nova Beats", sc.creatorName)
        assertEquals("/v1/discover/thumb/abcdef0123456789abcd", sc.thumbnail)
        assertEquals(185L, sc.durationSec)
        assertEquals("sc:112233445566:s01e01", sc.acquireId)
        assertTrue(sc.audioOnly)
        assertNotNull(sc.music)
        assertEquals("Nova Beats", sc.music?.artist)
        assertFalse(sc.inLibrary)

        val yt = DiscoverItem.from(
            JSONObject()
                .put("id", "youtube:nx32Ue0AAA0")
                .put("source", "youtube")
                .put("kind", "video")
                .put("itemId", "nx32Ue0AAA0")
                .put("title", "a rainy night & lofi rain")
                .put("creatorId", "youtube:UCSJ4gkVC6NrvII8umztf0Ow")
                .put("creatorName", "Lofi Girl")
                .put("creatorUrl", "https://www.youtube.com/channel/UCSJ4gkVC6NrvII8umztf0Ow")
                .put("url", "https://www.youtube.com/watch?v=nx32Ue0AAA0")
                .put("thumbnail", JSONObject.NULL)
                .put("duration", JSONObject.NULL)
                .put("publishedAt", 1763492410000L)
                .put("acquireId", "clip:0123456789abcdef")
                .put("audioOnly", false)
                .put("music", JSONObject.NULL)
                .put("inLibrary", true),
        )
        assertEquals("", yt.thumbnail)
        assertNull(yt.durationSec)
        assertFalse(yt.audioOnly)
        assertNull(yt.music)
        assertTrue(yt.inLibrary)
    }

    @Test
    fun parsesDiscoverFeedWithItemsCreatorsAndPartialErrors() {
        val json = JSONObject()
            .put(
                "creators",
                JSONArray().put(
                    JSONObject()
                        .put("id", "youtube:UCSJ4gkVC6NrvII8umztf0Ow")
                        .put("source", "youtube")
                        .put("name", "Lofi Girl")
                        .put("url", "https://www.youtube.com/channel/UCSJ4gkVC6NrvII8umztf0Ow")
                        .put("avatar", "/v1/discover/thumb/aaaaaaaaaaaaaaaaaaaa")
                        .put("followedAt", 1763500000000L),
                ),
            )
            .put(
                "items",
                JSONArray().put(
                    JSONObject()
                        .put("id", "youtube:nx32Ue0AAA0")
                        .put("source", "youtube")
                        .put("kind", "video")
                        .put("title", "a rainy night")
                        .put("creatorId", "youtube:UCSJ4gkVC6NrvII8umztf0Ow")
                        .put("creatorName", "Lofi Girl")
                        .put("url", "https://www.youtube.com/watch?v=nx32Ue0AAA0")
                        .put("thumbnail", "/v1/discover/thumb/bbbbbbbbbbbbbbbbbbbb")
                        .put("acquireId", "clip:1234567890abcdef")
                        .put("audioOnly", false)
                        .put("inLibrary", false),
                ),
            )
            .put(
                "errors",
                JSONArray().put(
                    JSONObject()
                        .put("creatorId", "rumble:c/creatorone")
                        .put("source", "rumble")
                        .put("name", "CreatorOne")
                        .put("message", "Rumble answered 403"),
                ),
            )
            .put("updatedAt", 1763641000000L)

        val feed = DiscoverFeed.from(json)
        assertEquals(1, feed.creators.size)
        assertEquals(1, feed.items.size)
        assertEquals(1, feed.errors.size)
        assertEquals("CreatorOne", feed.errors[0].label)
        assertEquals("Rumble answered 403", feed.errors[0].message)
        assertEquals(1763641000000L, feed.updatedAt)
    }

    @Test
    fun parsesDiscoverBrowseResultAndResolvesLoopbackThumbsSafely() {
        val json = JSONObject()
            .put("query", "lofi")
            .put("sources", JSONArray(listOf("youtube", "soundcloud", "rumble")))
            .put(
                "creators",
                JSONArray().put(
                    JSONObject()
                        .put("id", "soundcloud:9a8b7c6d5e4f")
                        .put("source", "soundcloud")
                        .put("name", "Nova Beats")
                        .put("url", "https://soundcloud.com/nova-beats")
                        .put("avatar", "/v1/providers/soundcloud/thumb/9001")
                        .put("followed", false),
                ),
            )
            .put(
                "items",
                JSONArray().put(
                    JSONObject()
                        .put("id", "soundcloud:9001")
                        .put("source", "soundcloud")
                        .put("kind", "audio")
                        .put("title", "Midnight Tape")
                        .put("creatorName", "Nova Beats")
                        .put("creatorUrl", "https://soundcloud.com/nova-beats")
                        .put("url", "https://soundcloud.com/nova-beats/midnight-tape")
                        .put("thumbnail", "/v1/providers/soundcloud/thumb/9001")
                        .put("duration", 185)
                        .put("acquireId", "sc:abcdef123456:s01e01")
                        .put("audioOnly", true),
                ),
            )
            .put(
                "errors",
                JSONArray().put(
                    JSONObject()
                        .put("source", "rumble")
                        .put("message", "Rumble answered 403"),
                ),
            )

        val browse = DiscoverBrowseResult.from(json)
        assertEquals("lofi", browse.query)
        assertEquals(listOf("youtube", "soundcloud", "rumble"), browse.sources)
        assertEquals(1, browse.creators.size)
        assertFalse(browse.creators[0].followed)
        assertEquals(1, browse.items.size)
        assertEquals("/v1/providers/soundcloud/thumb/9001", browse.items[0].thumbnail)
        assertEquals(1, browse.errors.size)
        assertEquals("Rumble", browse.errors[0].label)

        assertEquals(
            "http://127.0.0.1:8174/v1/discover/thumb/0123456789abcdef0123",
            resolveLoopbackThumbUrl("http://127.0.0.1:8174/", "/v1/discover/thumb/0123456789abcdef0123"),
        )
        assertEquals(
            "http://127.0.0.1:8174/v1/providers/soundcloud/thumb/9001",
            resolveLoopbackThumbUrl("http://127.0.0.1:8174", "/v1/providers/soundcloud/thumb/9001"),
        )
        assertNull(resolveLoopbackThumbUrl("http://127.0.0.1:8174", "https://i.ytimg.com/vi/abc/hqdefault.jpg"))
        assertNull(resolveLoopbackThumbUrl(null, "/v1/discover/thumb/0123456789abcdef0123"))
        assertNull(resolveLoopbackThumbUrl("http://127.0.0.1:8174", ""))
    }

    @Test
    fun matchesFollowedCreatorByIdHandleUrlOrNameForUnfollow() {
        val followed = listOf(
            DiscoverCreator(
                id = "youtube:UCBJycsmduvYEL83R_U4JriQ",
                source = "youtube",
                handle = "@mkbhd",
                name = "Marques Brownlee",
                url = "https://www.youtube.com/channel/UCBJycsmduvYEL83R_U4JriQ",
                followed = true,
            ),
        )
        val byHandle = com.peartube.app.ui.findFollowedCreator(
            creators = followed,
            id = "youtube:@mkbhd",
            url = "https://www.youtube.com/@mkbhd",
            handle = "@mkbhd",
            source = "youtube",
            name = "Marques Brownlee",
        )
        assertEquals("youtube:UCBJycsmduvYEL83R_U4JriQ", byHandle?.id)
        val missing = com.peartube.app.ui.findFollowedCreator(
            creators = followed,
            id = "youtube:@veritasium",
            url = "https://www.youtube.com/@veritasium",
            handle = "@veritasium",
            source = "youtube",
            name = "Veritasium",
        )
        assertNull(missing)
    }
}
