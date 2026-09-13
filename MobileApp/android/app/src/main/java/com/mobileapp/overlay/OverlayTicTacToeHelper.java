package com.mobileapp.overlay;

import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Random;

/**
 * Renders a native Tic-Tac-Toe game inside the mission overlay (ALL_IS_FIXED #51).
 *
 * Mirrors OverlayQuizHelper's shape exactly: a stateless utility class, one static show
 * method, all game state captured in local closures inside that single call — the class
 * itself has no fields. A hide/reshow or OverlayService restart therefore resets the board
 * rather than resuming it; this is a deliberate decision (brief §A2b), not an accident of
 * where the state happens to live: nothing in the overlay's rebuild path
 * (OverlayService#showOverlayFromIntent -> removeOverlayNow() then re-attach) persists
 * state, and a reset/partial board can never be mistaken for a played one once the backend's
 * replay validator is in place (an empty or partial board simply fails the replay).
 *
 * This is a second implementation of the TypeScript state machine
 * (src/missions/games/tttTurn.ts + gameLogic.ts) in a language that cannot share it, and it
 * has no unit tests — there is no render harness for this repo. It is code-review and
 * device-eyeball verified only.
 *
 * AI: exactly one difficulty tier (the "medium" logic from gameLogic.ts's tttAiMove) —
 * "easy" (pure random) and "hard" (minimax) are cut. The mission generator never sets
 * metadata.aiDifficulty for the tictactoe template, so those tiers are unreachable dead code
 * in the native path by construction (ALL_IS_FIXED-51 D2). metadata.aiDifficulty is parsed
 * defensively but any value maps to this one implemented tier.
 */
public final class OverlayTicTacToeHelper {

    private static final int[][] LINES = {
            {0, 1, 2}, {3, 4, 5}, {6, 7, 8},
            {0, 3, 6}, {1, 4, 7}, {2, 5, 8},
            {0, 4, 8}, {2, 4, 6},
    };

    /** Mirrors TicTacToeGame.tsx's AI_MOVE_DELAY_MS — reads as "thinking". */
    private static final long AI_MOVE_DELAY_MS = 450;

    private OverlayTicTacToeHelper() {}

    public interface GameFinishedListener {
        void onGameFinished(String missionId, String missionType, String metadataJson);

        void onGameNeedsInApp(
                String missionId,
                String title,
                int points,
                String missionType,
                String metadataJson);
    }

    /** null = not decided, "X"/"O" = a line, "draw" = full board, no line. */
    private static String checkWinner(String[] board) {
        for (int[] line : LINES) {
            String a = board[line[0]];
            String b = board[line[1]];
            String c = board[line[2]];
            if (!"".equals(a) && a.equals(b) && a.equals(c)) {
                return a;
            }
        }
        for (String cell : board) {
            if ("".equals(cell)) {
                return null;
            }
        }
        return "draw";
    }

    /** medium tier only (D2): win if possible, else block, else center, else random. */
    private static int mediumAiMove(String[] board, Random random) {
        List<Integer> empty = new ArrayList<>();
        for (int i = 0; i < 9; i++) {
            if ("".equals(board[i])) {
                empty.add(i);
            }
        }
        if (empty.isEmpty()) {
            return -1;
        }
        for (int i : empty) {
            String[] copy = board.clone();
            copy[i] = "O";
            if ("O".equals(checkWinner(copy))) {
                return i;
            }
        }
        for (int i : empty) {
            String[] copy = board.clone();
            copy[i] = "X";
            if ("X".equals(checkWinner(copy))) {
                return i;
            }
        }
        if ("".equals(board[4])) {
            return 4;
        }
        return empty.get(random.nextInt(empty.size()));
    }

    public static void showGame(
            Context context,
            View overlayRoot,
            String missionId,
            String title,
            int points,
            String metadataJson,
            GameFinishedListener listener) {
        if (!(overlayRoot instanceof ViewGroup)) {
            listener.onGameNeedsInApp(missionId, title, points, "minigame", metadataJson);
            return;
        }
        ViewGroup rootGroup = (ViewGroup) overlayRoot;
        rootGroup.removeAllViews();

        final String metaJson = metadataJson != null ? metadataJson : "{}";

        // "" for empty (D4a) — one encoding shared by Java, the Joi schema and the TS types,
        // instead of three places a null could quietly disagree.
        final String[] board = {"", "", "", "", "", "", "", "", ""};
        final List<Integer> moveSequence = new ArrayList<>();
        final boolean[] gameOver = {false};
        // Turn lock — mirrors tttTurn.ts's `phase` field. Without this, every still-empty
        // cell stays tappable during the AI's ~450ms "thinking" delay, letting the child
        // place a second X before the AI replies (cell-occupancy alone is not a turn lock).
        final boolean[] humanTurn = {true};
        final Random random = new Random();
        final Handler mainHandler = new Handler(Looper.getMainLooper());

        LinearLayout card = buildCard(context);

        TextView badge = new TextView(context);
        badge.setText(context.getString(com.mobileapp.R.string.overlay_mission_badge));
        badge.setTextColor(Color.parseColor("#FBBF24"));
        badge.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        badge.setTypeface(null, Typeface.BOLD);
        card.addView(badge);

        TextView titleView = new TextView(context);
        titleView.setText(title != null ? title : "Tic-Tac-Toe");
        titleView.setTextColor(Color.WHITE);
        titleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        titleView.setTypeface(null, Typeface.BOLD);
        titleView.setPadding(0, dp(context, 8), 0, 0);
        card.addView(titleView);

        TextView pointsView = new TextView(context);
        pointsView.setText(points + " points · minigame");
        pointsView.setTextColor(Color.parseColor("#94A3B8"));
        pointsView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        pointsView.setPadding(0, dp(context, 8), 0, dp(context, 4));
        card.addView(pointsView);

        final TextView statusView = new TextView(context);
        statusView.setText("Your turn (X)");
        statusView.setTextColor(Color.parseColor("#94A3B8"));
        statusView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        statusView.setTypeface(null, Typeface.BOLD);
        statusView.setPadding(0, dp(context, 4), 0, dp(context, 12));
        card.addView(statusView);

        // Scroll-safe from the first line (§A2a) — the existing overlay card was measured
        // overflowing at 1600x720 landscape; a 3x3 board plus status text is taller than a
        // quiz question. This is the only layout work in this brief (not #46).
        ScrollView scroll = new ScrollView(context);
        LinearLayout gridWrap = new LinearLayout(context);
        gridWrap.setOrientation(LinearLayout.VERTICAL);
        gridWrap.setGravity(Gravity.CENTER_HORIZONTAL);
        scroll.addView(
                gridWrap,
                new LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT));

        final Button[] cellButtons = new Button[9];
        LinearLayout[] rows = new LinearLayout[3];
        for (int r = 0; r < 3; r++) {
            rows[r] = new LinearLayout(context);
            rows[r].setOrientation(LinearLayout.HORIZONTAL);
            rows[r].setGravity(Gravity.CENTER_HORIZONTAL);
            gridWrap.addView(rows[r]);
        }

        final Runnable[] renderBoard = new Runnable[1];
        final Runnable[] finish = new Runnable[1];
        final Runnable[] aiTurn = new Runnable[1];

        renderBoard[0] =
                () -> {
                    for (int i = 0; i < 9; i++) {
                        Button b = cellButtons[i];
                        b.setText(board[i]);
                        b.setTextColor("O".equals(board[i]) ? Color.parseColor("#F87171") : Color.WHITE);
                        b.setEnabled(!gameOver[0] && humanTurn[0] && "".equals(board[i]));
                        b.setAlpha(b.isEnabled() ? 1f : 0.85f);
                    }
                };

        finish[0] =
                () -> {
                    gameOver[0] = true;
                    renderBoard[0].run();
                    String result = checkWinner(board); // "X" | "O" | "draw" (never null here)
                    boolean won = "X".equals(result);
                    statusView.setText(
                            won ? "You win! 🎉" : "draw".equals(result) ? "It's a draw" : "AI wins");

                    try {
                        JSONObject meta = new JSONObject(metaJson);
                        JSONArray finalBoard = new JSONArray();
                        for (String cell : board) {
                            finalBoard.put(cell);
                        }
                        JSONArray moves = new JSONArray();
                        for (int idx : moveSequence) {
                            moves.put(idx);
                        }
                        meta.put("finalBoard", finalBoard);
                        meta.put("moveSequence", moves);
                        meta.put("won", won); // informational only — the backend derives its own outcome
                        listener.onGameFinished(missionId, "minigame", meta.toString());
                    } catch (Exception e) {
                        listener.onGameFinished(missionId, "minigame", metaJson);
                    }
                };

        aiTurn[0] =
                () -> {
                    if (gameOver[0]) {
                        return;
                    }
                    int aiIndex = mediumAiMove(board, random);
                    if (aiIndex < 0) {
                        finish[0].run(); // board full — resolve() would have already caught this as a draw
                        return;
                    }
                    board[aiIndex] = "O";
                    moveSequence.add(aiIndex);
                    if (checkWinner(board) != null) {
                        finish[0].run();
                        return;
                    }
                    humanTurn[0] = true;
                    statusView.setText("Your turn (X)");
                    renderBoard[0].run();
                };

        for (int i = 0; i < 9; i++) {
            final int index = i;
            Button cellBtn = new Button(context);
            LinearLayout.LayoutParams cellLp =
                    new LinearLayout.LayoutParams(dp(context, 88), dp(context, 88));
            cellLp.setMargins(dp(context, 3), dp(context, 3), dp(context, 3), dp(context, 3));
            cellBtn.setAllCaps(false);
            cellBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 30);
            cellBtn.setTextColor(Color.WHITE);
            cellBtn.setTypeface(null, Typeface.BOLD);
            cellBtn.setBackgroundColor(Color.parseColor("#1E293B"));
            cellBtn.setOnClickListener(
                    v -> {
                        if (gameOver[0] || !humanTurn[0] || !"".equals(board[index])) {
                            return; // turn lock / occupied-cell guard, mirrors tttTurn.ts
                        }
                        board[index] = "X";
                        moveSequence.add(index);
                        humanTurn[0] = false; // locks every cell via renderBoard below, not just this one
                        renderBoard[0].run();
                        if (checkWinner(board) != null) {
                            finish[0].run();
                            return;
                        }
                        statusView.setText("AI is thinking…");
                        mainHandler.postDelayed(() -> aiTurn[0].run(), AI_MOVE_DELAY_MS);
                    });
            cellButtons[i] = cellBtn;
            rows[i / 3].addView(cellBtn, cellLp);
        }

        renderBoard[0].run();
        card.addView(
                scroll,
                new LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));

        android.widget.FrameLayout.LayoutParams rootLp =
                new android.widget.FrameLayout.LayoutParams(
                        android.widget.FrameLayout.LayoutParams.MATCH_PARENT,
                        android.widget.FrameLayout.LayoutParams.MATCH_PARENT);
        rootLp.gravity = Gravity.CENTER;
        rootLp.setMargins(dp(context, 20), dp(context, 32), dp(context, 20), dp(context, 32));
        if (rootGroup instanceof android.widget.FrameLayout) {
            ((android.widget.FrameLayout) rootGroup).addView(card, rootLp);
        } else {
            rootGroup.addView(card);
        }
    }

    private static LinearLayout buildCard(Context context) {
        LinearLayout card = new LinearLayout(context);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackgroundResource(com.mobileapp.R.drawable.overlay_mission_card);
        card.setPadding(dp(context, 20), dp(context, 20), dp(context, 20), dp(context, 20));
        card.setElevation(dp(context, 12));
        return card;
    }

    private static int dp(Context context, int value) {
        float density = context.getResources().getDisplayMetrics().density;
        return Math.round(value * density);
    }
}
