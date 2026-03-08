import { ref, computed, reactive, watch } from '@nuxtjs/composition-api';
import { defineStore } from 'pinia';
import useSentry from '~/composables/useSentry';
import LoadingStatus from '~/enums/LoadingStatus';
import sites from '~/data/sites.json';
import { buildEmptyData, preprocessData } from '~/utils';
import type { Data, Sheet } from '~/types';

// eslint-disable-next-line import/prefer-default-export
export const useDataStore = defineStore('data', () => {
  const currentGameCode = ref<string | null>(null);

  const loadedData = ref(new Map<string | null, Data>());
  const loadingStatuses = ref(new Map<string | null, LoadingStatus>());
  const loadingErrorMessages = ref(new Map<string | null, string>());

  const loadedSelectedSheets = ref(new Map<string | null, Sheet[]>());

  const currentData = computed(
    () => loadedData.value.get(currentGameCode.value) ?? buildEmptyData(),
  );
  const currentLoadingStatus = computed(
    () => loadingStatuses.value.get(currentGameCode.value) ?? LoadingStatus.PENDING,
  );
  const currentLoadingErrorMessage = computed(
    () => loadingErrorMessages.value.get(currentGameCode.value) ?? '',
  );

  const currentSelectedSheets = computed({
    get() {
      return loadedSelectedSheets.value.get(currentGameCode.value) ?? [];
    },
    set(value) {
      loadedSelectedSheets.value = new Map(loadedSelectedSheets.value.set(
        currentGameCode.value,
        value,
      ));
    },
  });

  const sentry = useSentry();

  async function loadData(gameCode: string) {
    const dataSourceUrl = sites.find((site) => site.gameCode === gameCode)?.dataSourceUrl;

    if (dataSourceUrl === undefined) {
      // eslint-disable-next-line no-console
      console.warn(`"${gameCode}" is not a valid gameCode`);
      return;
    }

    // helper functions
    function setLoadedData(data: Data) {
      loadedData.value = new Map(loadedData.value.set(gameCode, data));
    }
    function setLoadingStatus(status: LoadingStatus) {
      loadingStatuses.value = new Map(loadingStatuses.value.set(gameCode, status));
    }
    function setLoadingErrorMessage(message: string) {
      loadingErrorMessages.value = new Map(loadingErrorMessages.value.set(gameCode, message));
    }

    try {
      setLoadingStatus(LoadingStatus.LOADING);

      let data: Data;

      // Prefer local static JSON (for dev / offline) when running in browser
      if (typeof window !== 'undefined') {
        const localResponse = await fetch(`/${gameCode}/data.json`);
        if (localResponse.ok) {
          data = await localResponse.json() as Data;
        } else {
          const response = await fetch(`${dataSourceUrl}/data.json`);
          data = await response.json() as Data;
        }
      } else {
        // On server-side render, use the CDN URL (absolute) to avoid relative URL issues
        const response = await fetch(`${dataSourceUrl}/data.json`);
        data = await response.json() as Data;
      }

      // Ensure video property exists for reactivity in Vue 2/Pinia.
      // Use a reactive object so internal fields (e.g. youtube.id) can update the UI.
      for (const song of data.songs) {
        const songAny = song as any;
        if (!songAny.video) {
          songAny.video = reactive({});
        }
      }

      // Optionally load video metadata (YouTube / NicoNico) if available.
      // If fetching the JSON fails (e.g. because the site is behind auth), fall back to the
      // locally bundled JSON in `static/<gameCode>/video.json`.
      try {
        const videoUrl = typeof window !== 'undefined'
          ? `/${gameCode}/video.json`
          : `${dataSourceUrl}/video.json`;

        const videoResponse = await fetch(videoUrl);
        if (!videoResponse.ok) {
          throw new Error(`Failed to fetch video metadata (${videoResponse.status})`);
        }

        const videoData = await videoResponse.json() as {
          videos: Record<string, any>;
        };

        for (const song of data.songs) {
          if (song.songId && videoData.videos?.[song.songId]) {
            // Ensure we mutate the existing `video` object rather than replace it.
            // This keeps Vue 2 reactivity working correctly.
            const songAny = song as any;
            songAny.video = songAny.video ?? reactive({});
            Object.assign(songAny.video, videoData.videos[song.songId]);
          }
        }
      } catch (err) {
        // Fallback: try to load the bundled static JSON.
        // This may work even if the main route is protected.
        try {
          // NOTE: dynamic import uses webpack alias; this makes it work in both build and dev.
          const videoData = (await import(
            `~/static/${gameCode}/video.json`
          )) as {
            videos: Record<string, any>;
          };
          for (const song of data.songs) {
            if (song.songId && videoData.videos?.[song.songId]) {
              // Ensure we mutate the existing `video` object rather than replace it.
              // This keeps Vue 2 reactivity working correctly.
              const songAny = song as any;
              songAny.video = songAny.video ?? reactive({});
              Object.assign(songAny.video, videoData.videos[song.songId]);
            }
          }
        } catch (innerErr) {
          // eslint-disable-next-line no-console
          console.warn('Failed to load video metadata', err, innerErr);
        }
      }

      preprocessData(data, dataSourceUrl, gameCode);

      setLoadedData(data);
      setLoadingStatus(LoadingStatus.LOADED);
    } catch (err: any) {
      sentry.captureException(err);

      setLoadingErrorMessage(err.message);
      setLoadingStatus(LoadingStatus.ERROR);
    }
  }

  watch(currentGameCode, async () => {
    if (currentGameCode.value === null) return;

    if (currentLoadingStatus.value === LoadingStatus.PENDING) {
      await loadData(currentGameCode.value);
    }
  });

  return {
    gameCode: currentGameCode,
    currentData,
    currentLoadingStatus,
    currentLoadingErrorMessage,
    currentSelectedSheets,
  };
});
