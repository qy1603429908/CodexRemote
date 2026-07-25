package dev.codexmobile.remote;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SecureTokenPlugin.class);
        registerPlugin(CodexBackgroundPlugin.class);
        registerPlugin(CodexFileTransferPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
