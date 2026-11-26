package io.github.santoshban.streamora

import io.github.santoshban.streamora.ServerSelector.Kind
import org.junit.Assert.assertEquals
import org.junit.Test

class ServerSelectorTest {
    private val home = "http://192.168.1.20:8484"
    private val tailscale = "http://100.101.102.103:8484"
    private val magicDns = "http://pc.tail1234.ts.net:8484"
    private val proxy = "https://media.example.com"

    @Test
    fun `addresses are sorted into home, VPN and other`() {
        assertEquals(Kind.LAN, ServerSelector.kind(home))
        assertEquals(Kind.LAN, ServerSelector.kind("http://10.0.0.5:8484"))
        assertEquals(Kind.LAN, ServerSelector.kind("http://172.20.1.1:8484"))
        assertEquals(Kind.LAN, ServerSelector.kind("http://nas.local:8484"))
        assertEquals(Kind.VPN, ServerSelector.kind(tailscale))
        assertEquals(Kind.VPN, ServerSelector.kind(magicDns))
        assertEquals(Kind.OTHER, ServerSelector.kind(proxy))
        assertEquals(Kind.OTHER, ServerSelector.kind("http://172.32.0.1:8484"))
        assertEquals(Kind.OTHER, ServerSelector.kind("http://100.128.0.1:8484"))
    }

    @Test
    fun `at home the home address comes first`() {
        assertEquals(listOf(home, tailscale, proxy), ServerSelector.ordered(listOf(proxy, tailscale, home), current = tailscale, onLocalNetwork = true))
    }

    @Test
    fun `away from home the VPN comes first and home addresses go last`() {
        assertEquals(listOf(tailscale, proxy, home), ServerSelector.ordered(listOf(home, proxy, tailscale), current = home, onLocalNetwork = false))
    }

    @Test
    fun `the address in use leads its group`() {
        assertEquals(listOf(magicDns, tailscale), ServerSelector.ordered(listOf(tailscale, magicDns), current = magicDns, onLocalNetwork = true))
    }
}
