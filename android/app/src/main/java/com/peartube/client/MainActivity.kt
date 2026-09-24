package com.peartube.client

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Typeface
import android.os.Bundle
import android.text.format.Formatter
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import android.widget.Toolbar
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

// Lists every entry in the relay's tracker, grouped by title. Tapping one
// plays its stream URL.
class MainActivity : Activity() {
    private class Entry(val id: String, val title: String, val size: Long, val local: Boolean, val streamUrl: String)

    // Either a title header or a playable entry.
    private class Row(val header: String?, val entry: Entry?)

    private val prefs by lazy { getSharedPreferences("peartube", MODE_PRIVATE) }
    private val relay get() = prefs.getString("relay", DEFAULT_RELAY)!!.trimEnd('/')
    private lateinit var status: TextView
    private var rows = emptyList<Row>()
    private var loading = 0

    private val adapter = object : BaseAdapter() {
        override fun getCount() = rows.size
        override fun getItem(position: Int) = rows[position]
        override fun getItemId(position: Int) = position.toLong()
        override fun getViewTypeCount() = 2
        override fun getItemViewType(position: Int) = if (rows[position].header != null) 0 else 1
        override fun isEnabled(position: Int) = rows[position].entry != null

        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            val row = rows[position]
            if (row.header != null) {
                val view = convertView as TextView? ?: TextView(this@MainActivity).apply {
                    setTypeface(typeface, Typeface.BOLD)
                    textSize = 18f
                    setPadding(dp(16), dp(20), dp(16), dp(6))
                }
                view.text = row.header
                return view
            }
            val view = convertView ?: layoutInflater.inflate(android.R.layout.simple_list_item_2, parent, false)
            val entry = row.entry!!
            view.findViewById<TextView>(android.R.id.text1).text = label(entry.id)
            view.findViewById<TextView>(android.R.id.text2).text =
                Formatter.formatShortFileSize(this@MainActivity, entry.size) + if (entry.local) "" else " · from a peer"
            return view
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        status = TextView(this).apply { setPadding(dp(16), dp(12), dp(16), dp(4)) }
        val list = ListView(this).apply {
            adapter = this@MainActivity.adapter
            setOnItemClickListener { _, _, position, _ -> play(rows[position].entry!!) }
        }
        // Android 15+ draws apps edge to edge: the root pads itself for the
        // system bars, and the toolbar lives inside it rather than in the decor.
        val toolbar = Toolbar(this).apply { title = "PearTube" }
        setActionBar(toolbar)
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            fitsSystemWindows = true
            addView(toolbar)
            addView(status)
            addView(list, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        })
    }

    override fun onStart() {
        super.onStart()
        load()
    }

    private fun load() {
        val relay = relay
        val attempt = ++loading
        status.text = "Loading $relay…"
        thread {
            val result = runCatching { fetchEntries(relay) }
            runOnUiThread {
                if (attempt != loading || isDestroyed) return@runOnUiThread
                result.onSuccess { entries ->
                    rows = group(entries)
                    val titles = entries.map { it.title }.distinct().size
                    status.text = if (entries.isEmpty()) "No archived media on $relay" else "${entries.size} files, $titles titles · $relay"
                }.onFailure { err ->
                    rows = emptyList()
                    status.text = "Could not reach $relay: ${err.message}"
                }
                adapter.notifyDataSetChanged()
            }
        }
    }

    private fun fetchEntries(relay: String): List<Entry> {
        val conn = URL("$relay/v1/entries").openConnection() as HttpURLConnection
        conn.connectTimeout = 10_000
        conn.readTimeout = 30_000
        try {
            if (conn.responseCode != 200) error("HTTP ${conn.responseCode}")
            val results = JSONObject(conn.inputStream.bufferedReader().readText()).getJSONArray("results")
            return List(results.length()) { i ->
                val r = results.getJSONObject(i)
                Entry(r.getString("id"), r.getString("title"), r.getLong("size"), r.getBoolean("local"), r.getString("streamUrl"))
            }
        } finally {
            conn.disconnect()
        }
    }

    private fun group(entries: List<Entry>): List<Row> =
        entries.groupBy { it.title }.toSortedMap(String.CASE_INSENSITIVE_ORDER).flatMap { (title, items) ->
            listOf(Row(title, null)) + items.sortedBy { it.id }.map { Row(null, it) }
        }

    private fun play(entry: Entry) {
        startActivity(Intent(this, PlayerActivity::class.java).putExtra(PlayerActivity.EXTRA_URL, entry.streamUrl))
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menu.add(0, MENU_REFRESH, 0, "Refresh").setShowAsAction(MenuItem.SHOW_AS_ACTION_IF_ROOM)
        menu.add(0, MENU_RELAY, 1, "Relay…")
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        when (item.itemId) {
            MENU_REFRESH -> load()
            MENU_RELAY -> editRelay()
            else -> return super.onOptionsItemSelected(item)
        }
        return true
    }

    private fun editRelay() {
        val input = EditText(this).apply { setText(relay); setSingleLine() }
        AlertDialog.Builder(this)
            .setTitle("Relay URL")
            .setView(input)
            .setPositiveButton("Save") { _, _ ->
                prefs.edit().putString("relay", input.text.toString().trim().ifEmpty { DEFAULT_RELAY }).apply()
                load()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    companion object {
        const val DEFAULT_RELAY = "http://10.0.40.100:8174"
        private const val MENU_REFRESH = 1
        private const val MENU_RELAY = 2
        private val EPISODE = Regex(":s(\\d{2})e(\\d{2,3})$")

        // imdb:tt0106064:s06e27 -> S06E27; a movie id has no episode part.
        fun label(id: String) = EPISODE.find(id)?.let { "S${it.groupValues[1]}E${it.groupValues[2]}" } ?: "Movie"
    }
}
