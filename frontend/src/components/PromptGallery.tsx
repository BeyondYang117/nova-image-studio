import { useState, useEffect, useMemo, useRef, useCallback, memo } from 'react';
import { Search, Loader2, AlertCircle, ExternalLink, ChevronUp } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  PromptCard,
  PromptDetailModal,
  PromptGalleryImagePreviewModal,
} from '@/components/prompt-gallery/PromptGallerySubcomponents';
import {
  ALL_CATEGORY,
  DEFAULT_CATEGORIES,
  PROMPT_DATA_SOURCES,
  fetchAllPromptSources,
  getPromptSourceLabel,
  type PromptWithKey,
} from '@/lib/prompt-gallery-data';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { seededShuffle } from '@/lib/seeded-shuffle';
import { apiPath } from '@/lib/integration';

const PROMPT_GALLERY_STEP = 20;
const PROMPT_GALLERY_WIDE_STEP = 30;

const PromptGallery = memo(function PromptGallery({ wideMode = false }: { wideMode?: boolean }) {
  const pageStep = wideMode ? PROMPT_GALLERY_WIDE_STEP : PROMPT_GALLERY_STEP;
  const [allPrompts, setAllPrompts] = useState<PromptWithKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [blacklist, setBlacklist] = useState<string[]>([]);
  const [selectedCategory, setSelectedCategory] = useState(ALL_CATEGORY);
  const [categories, setCategories] = useState<string[]>(DEFAULT_CATEGORIES);
  const [detailPrompt, setDetailPrompt] = useState<PromptWithKey | null>(null);
  const [imagePreview, setImagePreview] = useState<{ prompt: PromptWithKey; initialIndex: number } | null>(null);
  const [imageCache, setImageCache] = useState<Set<string>>(new Set());
  const [displayCount, setDisplayCount] = useState(pageStep);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(apiPath('/api/nova/blacklist'))
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data.keywords)) {
          setBlacklist(data.keywords.map((keyword: string) => keyword.toLowerCase()));
        }
      })
      .catch(() => {
        setBlacklist([]);
      });

    fetchAllPromptSources()
      .then((result) => {
        setCategories(result.categories);
        setAllPrompts(result.prompts);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : '提示词广场加载失败');
        setLoading(false);
      });
  }, []);

  const handleShowDetail = useCallback((prompt: PromptWithKey) => {
    setDetailPrompt(prompt);
  }, []);

  const handleShowImages = useCallback((prompt: PromptWithKey, initialIndex = 0) => {
    setImagePreview({ prompt, initialIndex });
  }, []);

  const handleImageLoad = useCallback((url: string) => {
    setImageCache((prev) => {
      if (prev.has(url)) return prev;
      const next = new Set(prev);
      next.add(url);
      return next;
    });
  }, []);

  const baseFilteredPrompts = useMemo(() => {
    let prompts = allPrompts;

    if (blacklist.length > 0) {
      prompts = prompts.filter((prompt) => {
        const contentToCheck = [
          prompt.title.toLowerCase(),
          prompt.content.toLowerCase(),
          prompt.contributor?.toLowerCase() || '',
          prompt.notes?.toLowerCase() || '',
          ...prompt.tags.map((tag) => tag.toLowerCase()),
        ].join(' ');

        return !blacklist.some((keyword) => contentToCheck.includes(keyword));
      });
    }

    const hasChinese = (text: string) => /[\u4e00-\u9fa5]/.test(text);
    prompts = prompts.filter((prompt) => hasChinese(prompt.title) || hasChinese(prompt.content));

    if (selectedCategory !== ALL_CATEGORY) {
      prompts = prompts.filter((prompt) => prompt.category === selectedCategory);
    }

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      prompts = prompts.filter((prompt) => (
        prompt.title.toLowerCase().includes(query)
        || prompt.content.toLowerCase().includes(query)
        || (prompt.contributor && prompt.contributor.toLowerCase().includes(query))
      ));
    }

    return prompts;
  }, [allPrompts, blacklist, searchQuery, selectedCategory]);

  const filteredPrompts = useMemo(() => {
    const seed = `${searchQuery}\0${blacklist.join('\0')}\0${baseFilteredPrompts.map((prompt) => prompt.uniqueKey).join('\0')}`;
    return seededShuffle(baseFilteredPrompts, seed);
  }, [baseFilteredPrompts, blacklist, searchQuery]);

  useEffect(() => {
    queueMicrotask(() => setDisplayCount(pageStep));
  }, [pageStep, searchQuery, selectedCategory]);

  useEffect(() => {
    if (!loadMoreRef.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && displayCount < filteredPrompts.length) {
          setDisplayCount((prev) => Math.min(prev + pageStep, filteredPrompts.length));
        }
      },
      { rootMargin: '400px' },
    );

    observer.observe(loadMoreRef.current);
    return () => observer.disconnect();
  }, [displayCount, filteredPrompts.length, pageStep]);

  useEffect(() => {
    const handleScroll = () => {
      setShowScrollTop(window.scrollY > 500);
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const displayedPrompts = useMemo(() => filteredPrompts.slice(0, displayCount), [displayCount, filteredPrompts]);
  const hasMore = displayCount < filteredPrompts.length;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-20">
        <AlertCircle className="w-12 h-12 text-destructive" />
        <p className="text-destructive">{error}</p>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-6">
        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="搜索提示词、标题或作者..."
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              className="pl-9"
            />
          </div>

          <div className="flex flex-wrap gap-2">
            {categories.map((category) => (
              <Badge
                key={category}
                variant={selectedCategory === category ? 'default' : 'secondary'}
                className="cursor-pointer px-3 py-1 transition-colors hover:bg-primary/80"
                onClick={() => setSelectedCategory(category)}
              >
                {category}
              </Badge>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            找到 {filteredPrompts.length} 个提示词{displayedPrompts.length < filteredPrompts.length ? ` · 显示 ${displayedPrompts.length} 个` : ''}
          </span>
          <Popover>
            <PopoverTrigger className="flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground">
              <span>提示词来源</span>
              <ExternalLink className="w-3 h-3" />
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 p-2">
              <p className="px-2 pb-1.5 text-xs font-medium text-muted-foreground">提示词来源（{PROMPT_DATA_SOURCES.length}）</p>
              <div className="space-y-0.5">
                {PROMPT_DATA_SOURCES.map((source) => (
                  <a
                    key={source.name}
                    href={source.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted"
                  >
                    <span className="truncate">{getPromptSourceLabel(source.sourceUrl)}</span>
                    <ExternalLink className="w-3 h-3 flex-shrink-0 text-muted-foreground" />
                  </a>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        </div>

        <div className={`grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 ${wideMode ? '2xl:grid-cols-5' : ''}`}>
          {displayedPrompts.map((prompt) => (
            <PromptCard
              key={prompt.uniqueKey}
              prompt={prompt}
              onShowDetail={() => handleShowDetail(prompt)}
              onShowImages={(initialIndex) => handleShowImages(prompt, initialIndex)}
              imageCache={imageCache}
              onImageLoad={handleImageLoad}
            />
          ))}
        </div>

        {hasMore && (
          <div ref={loadMoreRef} className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {filteredPrompts.length === 0 && (
          <div className="py-12 text-center text-muted-foreground">
            没有找到匹配的提示词
          </div>
        )}
      </div>

      {showScrollTop && (
        <button
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          className="fixed bottom-6 right-6 z-40 flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-105 active:scale-95"
          aria-label="回到顶部"
        >
          <ChevronUp className="h-5 w-5" />
        </button>
      )}

      {detailPrompt && (
        <PromptDetailModal
          prompt={detailPrompt}
          onClose={() => setDetailPrompt(null)}
        />
      )}

      {imagePreview && (
        <PromptGalleryImagePreviewModal
          images={imagePreview.prompt.images}
          title={imagePreview.prompt.title}
          prompt={imagePreview.prompt}
          initialIndex={imagePreview.initialIndex}
          onClose={() => setImagePreview(null)}
        />
      )}
    </>
  );
});

export { PromptGallery };
