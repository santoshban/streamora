package io.github.santoshban.streamora

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ServerAddressTest {
    @Test
    fun `a bare address gets http and Streamora's port`() {
        assertEquals("http://192.168.1.20:8484", ServerAddress.normalize("192.168.1.20"))
        assertEquals("http://nas.local:8484", ServerAddress.normalize("  nas.local  "))
    }

    @Test
    fun `a typed port and trailing slash are kept and dropped`() {
        assertEquals("http://192.168.1.20:8485", ServerAddress.normalize("192.168.1.20:8485/"))
    }

    @Test
    fun `a full URL is taken as typed, without its path`() {
        assertEquals("http://nas.local", ServerAddress.normalize("http://nas.local"))
        assertEquals("https://media.example.com", ServerAddress.normalize("https://media.example.com/"))
        assertEquals("http://Host:9000", ServerAddress.normalize("HTTP://Host:9000/browse"))
    }

    @Test
    fun `IPv6 literals keep their brackets`() {
        assertEquals("http://[fe80::1]:8484", ServerAddress.normalize("[fe80::1]:8484"))
    }

    @Test
    fun `junk is rejected`() {
        assertNull(ServerAddress.normalize(""))
        assertNull(ServerAddress.normalize("my server"))
        assertNull(ServerAddress.normalize("ftp://nas.local"))
        assertNull(ServerAddress.normalize("http://"))
    }

    @Test
    fun `display drops the http scheme only`() {
        assertEquals("192.168.1.20:8484", ServerAddress.display("http://192.168.1.20:8484"))
        assertEquals("https://media.example.com", ServerAddress.display("https://media.example.com"))
    }
}
