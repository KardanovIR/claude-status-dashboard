package com.claudestatus.dashboard

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.claudestatus.dashboard.databinding.ActivitySetupBinding

class SetupActivity : AppCompatActivity() {

    private lateinit var binding: ActivitySetupBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivitySetupBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.urlInput.setText(Prefs.dashboardUrl(this).orEmpty())
        binding.keepAwakeSwitch.isChecked = Prefs.keepAwake(this)

        binding.saveButton.setOnClickListener { onSave() }
        binding.cancelButton.visibility =
            if (Prefs.dashboardUrl(this).isNullOrBlank()) View.GONE else View.VISIBLE
        binding.cancelButton.setOnClickListener { finish() }
    }

    private fun onSave() {
        val raw = binding.urlInput.text?.toString()?.trim().orEmpty()
        val normalized = normalize(raw)
        if (normalized == null) {
            binding.urlInput.error = getString(R.string.setup_url_invalid)
            return
        }
        Prefs.setDashboardUrl(this, normalized)
        Prefs.setKeepAwake(this, binding.keepAwakeSwitch.isChecked)
        Toast.makeText(this, R.string.setup_saved, Toast.LENGTH_SHORT).show()
        setResult(Activity.RESULT_OK, Intent().putExtra(EXTRA_URL, normalized))
        finish()
    }

    private fun normalize(input: String): String? {
        if (input.isBlank()) return null
        val withScheme = if (input.contains("://")) input else "http://$input"
        return runCatching {
            val uri = android.net.Uri.parse(withScheme)
            val scheme = uri.scheme?.lowercase()
            if (scheme != "http" && scheme != "https") return null
            if (uri.host.isNullOrBlank()) return null
            withScheme.trimEnd('/')
        }.getOrNull()
    }

    companion object {
        const val EXTRA_URL = "dashboard_url"
    }
}
