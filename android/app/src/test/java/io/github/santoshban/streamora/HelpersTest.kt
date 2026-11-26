package io.github.santoshban.streamora

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class HelpersTest {
    @Test
    fun `neighbours covers the subnet except the phone`() {
        val hosts = Discovery.neighbours(byteArrayOf(192.toByte(), 168.toByte(), 1, 37))
        assertEquals(253, hosts.size)
        assertEquals("192.168.1.1", hosts.first())
        assertEquals("192.168.1.254", hosts.last())
        assertFalse("192.168.1.37" in hosts)
    }

    @Test
    fun `codec names keep the table order and use the server's names`() {
        val supported = setOf("video/avc", "video/hevc", "audio/eac3", "audio/mp4a-latm")
        assertEquals(listOf("h264", "hevc"), Capabilities.names(Capabilities.VIDEO_MIME) { it in supported })
        assertEquals(listOf("aac", "eac3"), Capabilities.names(Capabilities.AUDIO_MIME) { it in supported })
    }

    @Test
    fun `channel labels`() {
        assertEquals("Stereo", channelLabel(2))
        assertEquals("5.1", channelLabel(6))
        assertEquals("3 ch", channelLabel(3))
    }

    @Test
    fun `a next episode starts where the web UI would start it`() {
        assertEquals(754.0, PlayTarget(7, "S1:E2", null, 754.0, resume = true).startSeconds, 0.0)
        assertEquals(0.0, PlayTarget(7, "S1:E2", null, 754.0, resume = false).startSeconds, 0.0)
    }
}
