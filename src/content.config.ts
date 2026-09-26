import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const metadataDefinition = () =>
  z
    .object({
      title: z.string().optional(),
      ignoreTitleTemplate: z.boolean().optional(),
      canonical: z.string().optional(),
      robots: z
        .object({
          index: z.boolean().optional(),
          follow: z.boolean().optional(),
        })
        .optional(),
      description: z.string().optional(),
      openGraph: z
        .object({
          url: z.string().optional(),
          siteName: z.string().optional(),
          images: z
            .array(
              z.object({
                url: z.string(),
                width: z.number().optional(),
                height: z.number().optional(),
              })
            )
            .optional(),
          locale: z.string().optional(),
          type: z.string().optional(),
        })
        .optional(),
      twitter: z
        .object({
          handle: z.string().optional(),
          site: z.string().optional(),
          cardType: z.string().optional(),
        })
        .optional(),
    })
    .optional();

// Base SEO schema for all content types
const baseSeoSchema = z.object({
  title: z.string().describe('Page title'),
  description: z.string().describe('Meta description'),
  excerpt: z.string().optional(),
  slug: z.string(),

  publishDate: z.coerce.date(),
  updateDate: z.coerce.date().optional(),
  draft: z.boolean().optional().default(false),

  keywords: z.array(z.string()).default([]),
  mainKeyword: z.string().optional(),

  author: z.string().optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  image: z.string().optional(),

  relatedArticles: z.array(z.string()).optional(),
  midRelated: z.boolean().optional(),
  internalLinks: z
    .array(
      z.object({
        text: z.string(),
        slug: z.string(),
        anchorText: z.string().optional(),
      })
    )
    .optional(),

  geoTarget: z.string().optional(),
  difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
  seoScore: z.number().min(0).max(100).optional(),

  metadata: metadataDefinition(),
});

// 1. Articles - Информационный контент
const articlesCollection = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/articles' }),
  schema: baseSeoSchema.extend({
    type: z.literal('article').optional(),
    readingTime: z.number().optional(),
    seoReady: z.boolean().optional().default(false),
    isArchived: z.boolean().optional().default(false),
    noindex: z.boolean().optional().default(false),
    schema: z.literal('Article').optional(),
  }),
});

// 2. Guides - Пошаговые инструкции
const guidesCollection = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/guides' }),
  schema: baseSeoSchema.extend({
    type: z.literal('guide').optional(),
    steps: z
      .array(
        z.object({
          title: z.string(),
          description: z.string(),
          image: z.string().optional(),
        })
      )
      .optional(),
    readingTime: z.number().optional(),
  }),
});

const projectBlockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hero'),
    title: z.string().optional(),
    description: z.string().optional(),
    subtitle: z.string().optional(),
    image: z.string().optional(),
    badge: z.string().optional(),
  }),
  z.object({
    type: z.literal('gallery'),
    images: z.array(z.string()).optional(),
    captions: z.record(z.string(), z.string()).optional(),
    includeHero: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('specs'),
  }),
  z.object({
    type: z.literal('cost'),
    label: z.string().optional(),
    note: z.string().optional(),
  }),
  z.object({
    type: z.literal('task'),
    title: z.string().optional(),
    text: z.string().optional(),
  }),
  z.object({
    type: z.literal('solution'),
    title: z.string().optional(),
    text: z.string().optional(),
  }),
  z.object({
    type: z.literal('split'),
    title: z.string(),
    text: z.string(),
    image: z.string().optional(),
    imageAlt: z.string().optional(),
    layout: z.enum(['imageLeft', 'imageRight']).optional(),
    anchor: z.string().optional(),
    tocLabel: z.string().optional(),
  }),
  z.object({
    type: z.literal('quote'),
    text: z.string(),
    author: z.string().optional(),
    role: z.string().optional(),
    image: z.string().optional(),
    anchor: z.string().optional(),
    tocLabel: z.string().optional(),
  }),
  z.object({
    type: z.literal('materials'),
    items: z
      .array(
        z.object({
          label: z.string(),
          value: z.string(),
          icon: z.string().optional(),
        })
      )
      .optional(),
  }),
  z.object({
    type: z.literal('process'),
    steps: z
      .array(
        z.object({
          title: z.string(),
          description: z.string(),
          meta: z.string().optional(),
          tag: z.string().optional(),
          label: z.string().optional(),
        })
      )
      .optional(),
  }),
  z.object({
    type: z.literal('beforeAfter'),
    items: z
      .array(
        z.object({
          before: z.string(),
          after: z.string(),
          caption: z.string().optional(),
        })
      )
      .optional(),
  }),
  z.object({
    type: z.literal('video'),
  }),
  z.object({
    type: z.literal('result'),
    title: z.string().optional(),
  }),
  z.object({
    type: z.literal('faq'),
    items: z
      .array(
        z.object({
          question: z.string(),
          answer: z.string(),
        })
      )
      .optional(),
  }),
  z.object({
    type: z.literal('links'),
    links: z
      .array(
        z.object({
          text: z.string(),
          href: z.string(),
        })
      )
      .optional(),
  }),
  z.object({
    type: z.literal('cta'),
    title: z.string().optional(),
    highlight: z.string().optional(),
    description: z.string().optional(),
    primaryLabel: z.string().optional(),
    secondaryLabel: z.string().optional(),
  }),
  z.object({
    type: z.literal('related'),
  }),
]);

// 3. Projects - SEO кейсы
const projectsCollection = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/projects' }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    excerpt: z.string().optional(),
    cover: z.string().optional(),
    slug: z.string().optional(),
    draft: z.boolean().optional().default(false),
    publishDate: z.coerce.date().optional(),
    updateDate: z.coerce.date().optional(),

      city: z.literal('irkutsk'),
      service: z.enum(['kuhni', 'shkafy', 'garderobnye']),
      relatedServices: z.array(z.enum(['kuhni', 'shkafy', 'garderobnye'])).optional(),
      serviceLabelOverride: z
        .object({
          noun: z.string(),
          plural: z.string(),
          genitive: z.string(),
          accusative: z.string(),
        })
        .optional(),

    district: z.string().optional(),
    street: z.string().optional(),
    complex: z.string().optional(),

    area: z.number().positive().optional(),
    price: z.number().int().nonnegative().optional(),
    estimatedPrice: z.number().int().nonnegative().optional(),
    estimatedPriceNote: z.string().optional(),
    duration: z.number().int().positive().optional(),

    layout: z.string().optional(),
    style: z.string().optional(),

    materials: z
      .object({
        facade: z.string().optional(),
        tabletop: z.string().optional(),
        corpus: z.string().optional(),
        hardware: z.string().optional(),
      })
      .default({}),

    images: z.array(z.string()).default([]),
    imageBaseDir: z.string().optional(),
    imageCaptions: z.record(z.string(), z.string()).optional(),

    task: z.string().optional(),
    solution: z.string().optional(),
    process: z
      .array(
        z.object({
          title: z.string(),
          description: z.string(),
          meta: z.string().optional(),
          tag: z.string().optional(),
          label: z.string().optional(),
        })
      )
      .optional(),
    cost: z
      .object({
        from: z.number().optional(),
        to: z.number().optional(),
        note: z.string().optional(),
      })
      .optional(),
    beforeAfter: z
      .array(
        z.object({
          before: z.string(),
          after: z.string(),
          caption: z.string().optional(),
        })
      )
      .optional(),
    internalLinks: z
      .array(
        z.object({
          text: z.string(),
          href: z.string(),
        })
      )
      .optional(),
    relatedArticles: z.array(z.string()).optional(),

    faq: z
      .array(
        z.object({
          question: z.string(),
          answer: z.string(),
        })
      )
      .optional()
      .default([]),

    video: z
      .object({
        title: z.string(),
        description: z.string(),
        contentUrl: z.string(),
        embedUrl: z.string(),
        uploadDate: z.string(),
        thumbnail: z.string(),
      })
      .optional(),

    blocks: z.array(projectBlockSchema).optional(),

    metadata: metadataDefinition(),
  }),
});

// 4. Services
const servicesCollection = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/services' }),
  schema: z.object({
    title: z.string(),
    slug: z.string(),
    description: z.string().optional(),
  }),
});

// 5. Cities
const citiesCollection = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/cities' }),
  schema: z.object({
    title: z.string(),
    slug: z.string(),
    nameIn: z.string().optional(),
    description: z.string().optional(),
  }),
});

// 6. FAQ
const faqCollection = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/faq' }),
  schema: baseSeoSchema.extend({
    type: z.literal('faq').optional(),
    questions: z
      .array(
        z.object({
          question: z.string(),
          answer: z.string(),
          category: z.string().optional(),
        })
      )
      .optional(),
  }),
});

// 7. Legacy post collection
const postCollection = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/data/post' }),
  schema: z.object({
    publishDate: z.coerce.date().optional(),
    updateDate: z.coerce.date().optional(),
    draft: z.boolean().optional(),
    title: z.string(),
    excerpt: z.string().optional(),
    image: z.string().optional(),
    category: z.string().optional(),
    tags: z.array(z.string()).optional(),
    author: z.string().optional(),
    metadata: metadataDefinition(),
  }),
});

export const collections = {
  articles: articlesCollection,
  guides: guidesCollection,
  projects: projectsCollection,
  services: servicesCollection,
  cities: citiesCollection,
  faq: faqCollection,
  post: postCollection,
};
