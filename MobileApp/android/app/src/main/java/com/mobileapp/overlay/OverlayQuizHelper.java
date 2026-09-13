package com.mobileapp.overlay;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Renders quiz questions inside the mission overlay (stays on top of Chrome).
 *
 * ALL_IS_FIXED #46: restyled onto {@link OverlayChrome}'s shared full-bleed/inset/max-width
 * container, plus per-answer feedback (immediate right/wrong coloring, a brief hold, then
 * advance) — safe to build because R1 confirmed {@code correctAnswers} already ships in this
 * mission's metadata JSON today; see that brief's closeout for the exposure this newly reads
 * (previously unread; not newly created).
 */
public final class OverlayQuizHelper {

    private OverlayQuizHelper() {}

    public interface QuizFinishedListener {
        void onQuizFinished(String missionId, String missionType, String metadataJson);

        void onQuizNeedsInApp(
                String missionId,
                String title,
                int points,
                String missionType,
                String metadataJson);
    }

    /**
     * @return a canceller {@link Runnable} the caller MUST invoke before tearing down the
     *     overlay (mission abandoned/completed via another path) while a feedback hold may be
     *     pending — otherwise the posted advance-to-next-question callback fires against
     *     detached views or double-completes the mission. A no-op for every early-return path
     *     below (nothing was ever scheduled).
     */
    public static Runnable showQuiz(
            Context context,
            View overlayRoot,
            String missionId,
            String title,
            int points,
            String metadataJson,
            QuizFinishedListener listener) {
        Runnable noopCanceller = () -> {};

        if (!(overlayRoot instanceof ViewGroup)) {
            listener.onQuizNeedsInApp(missionId, title, points, "quiz", metadataJson);
            return noopCanceller;
        }
        ViewGroup rootGroup = (ViewGroup) overlayRoot;
        rootGroup.removeAllViews();

        JSONArray questions;
        JSONArray correctAnswers;
        try {
            JSONObject meta = new JSONObject(metadataJson != null ? metadataJson : "{}");
            questions = meta.optJSONArray("questions");
            if (questions == null || questions.length() == 0) {
                listener.onQuizNeedsInApp(missionId, title, points, "quiz", metadataJson);
                return noopCanceller;
            }
            // R1 (ALL_IS_FIXED #46): already present in this metadata today, unfiltered —
            // reading it here for feedback coloring, not adding it to the payload. See #52.
            correctAnswers = meta.optJSONArray("correctAnswers");
        } catch (Exception e) {
            listener.onQuizNeedsInApp(missionId, title, points, "quiz", metadataJson);
            return noopCanceller;
        }

        final JSONArray submittedAnswers = new JSONArray();
        final int[] index = {0};
        final boolean[] inputLocked = {false};
        final Handler mainHandler = new Handler(Looper.getMainLooper());
        final Runnable[] pendingAdvance = {null};

        LinearLayout card = OverlayChrome.buildCenteredScrollColumn(context, rootGroup);

        card.addView(OverlayChrome.badgeView(context));
        card.addView(OverlayChrome.titleView(context, title != null ? title : "Quiz"));

        TextView pointsView = OverlayChrome.captionView(context);
        pointsView.setText(OverlayChrome.captionText(points));
        pointsView.setPadding(
                0, OverlayChrome.dp(context, 8), 0, OverlayChrome.dp(context, 4));
        card.addView(pointsView);

        LinearLayout dotsRow = new LinearLayout(context);
        dotsRow.setOrientation(LinearLayout.HORIZONTAL);
        dotsRow.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams dotsLp =
                new LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT);
        dotsLp.bottomMargin = OverlayChrome.dp(context, 4);
        card.addView(dotsRow, dotsLp);

        final TextView progress = OverlayChrome.progressCountView(context);
        progress.setPadding(0, 0, 0, OverlayChrome.dp(context, 8));
        card.addView(progress);

        final TextView questionView = OverlayChrome.questionView(context);
        card.addView(questionView);

        LinearLayout optionsLayout = new LinearLayout(context);
        optionsLayout.setOrientation(LinearLayout.VERTICAL);
        card.addView(optionsLayout);

        final JSONArray finalCorrectAnswers = correctAnswers;
        final String metaJson = metadataJson != null ? metadataJson : "{}";
        final Runnable[] renderQuestion = new Runnable[1];
        renderQuestion[0] =
                () -> {
                    inputLocked[0] = false;
                    optionsLayout.removeAllViews();
                    if (index[0] >= questions.length()) {
                        try {
                            JSONObject meta = new JSONObject(metaJson);
                            meta.put("submittedAnswers", submittedAnswers);
                            listener.onQuizFinished(missionId, "quiz", meta.toString());
                        } catch (Exception e) {
                            listener.onQuizFinished(missionId, "quiz", metaJson);
                        }
                        return;
                    }
                    try {
                        JSONObject q = questions.getJSONObject(index[0]);
                        dotsRow.removeAllViews();
                        dotsRow.addView(
                                OverlayChrome.buildProgressDots(
                                        context, questions.length(), index[0]));
                        progress.setText(
                                "Question " + (index[0] + 1) + " / " + questions.length());
                        questionView.setText(q.optString("text", "Question"));
                        JSONArray opts = q.optJSONArray("options");
                        int count = opts != null ? opts.length() : 0;
                        final String correctLetter =
                                finalCorrectAnswers != null
                                        ? finalCorrectAnswers.optString(index[0], null)
                                        : null;
                        final Button[] currentButtons = new Button[count];
                        for (int i = 0; i < count; i++) {
                            final int optionIndex = i;
                            Button optBtn =
                                    OverlayChrome.optionButton(
                                            context,
                                            (char) ('A' + i) + ". " + opts.optString(i, ""));
                            LinearLayout.LayoutParams lp =
                                    new LinearLayout.LayoutParams(
                                            LinearLayout.LayoutParams.MATCH_PARENT,
                                            LinearLayout.LayoutParams.WRAP_CONTENT);
                            lp.topMargin = OverlayChrome.dp(context, 8);
                            currentButtons[i] = optBtn;
                            optBtn.setOnClickListener(
                                    v -> {
                                        // Single boolean gates the WHOLE optionsLayout, not
                                        // per-button — blocks same-button re-tap, a
                                        // different-button tap, and a fast double-tap racing
                                        // the transition (correction-13's failure mode).
                                        if (inputLocked[0]) {
                                            return;
                                        }
                                        inputLocked[0] = true;
                                        String chosen =
                                                String.valueOf((char) ('A' + optionIndex));
                                        // Commit first, unconditionally — the submitted
                                        // payload is identical whether or not feedback can be
                                        // shown below.
                                        submittedAnswers.put(chosen);
                                        for (Button b : currentButtons) {
                                            b.setEnabled(false);
                                        }
                                        if (correctLetter != null && !correctLetter.isEmpty()) {
                                            boolean isCorrect = chosen.equals(correctLetter);
                                            OverlayChrome.setOptionState(
                                                    optBtn,
                                                    isCorrect
                                                            ? OverlayChrome.OptionState.CORRECT
                                                            : OverlayChrome.OptionState
                                                                    .INCORRECT);
                                            if (!isCorrect) {
                                                int correctIdx = correctLetter.charAt(0) - 'A';
                                                if (correctIdx >= 0
                                                        && correctIdx < currentButtons.length) {
                                                    OverlayChrome.setOptionState(
                                                            currentButtons[correctIdx],
                                                            OverlayChrome.OptionState.CORRECT);
                                                }
                                            }
                                            pendingAdvance[0] =
                                                    () -> {
                                                        index[0] += 1;
                                                        renderQuestion[0].run();
                                                    };
                                            mainHandler.postDelayed(
                                                    pendingAdvance[0],
                                                    OverlayChrome.ANSWER_FEEDBACK_HOLD_MS);
                                        } else {
                                            // Defensive fallback only — R1 confirmed
                                            // correctAnswers is present for real quiz
                                            // missions; this question would just advance
                                            // immediately (pre-#46 behavior) if it weren't.
                                            index[0] += 1;
                                            renderQuestion[0].run();
                                        }
                                    });
                            optionsLayout.addView(optBtn, lp);
                        }
                    } catch (Exception e) {
                        listener.onQuizNeedsInApp(missionId, title, points, "quiz", metaJson);
                    }
                };

        renderQuestion[0].run();

        return () -> {
            if (pendingAdvance[0] != null) {
                mainHandler.removeCallbacks(pendingAdvance[0]);
            }
        };
    }
}
